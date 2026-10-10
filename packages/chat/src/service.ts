import {
  chatResults,
  contextTokens,
} from "../../observability/src/telemetry.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Logger } from "pino";
import type { Identity } from "../../security/src/auth.js";
import { withTenant } from "../../database/src/tenant.js";
import { type Vault } from "../../security/src/crypto.js";
import { AppError } from "../../shared/src/errors.js";
import type { Embedder } from "../../ai/src/embeddings.js";
import {
  applicableVersions,
  searchIndex,
} from "../../ingestion/src/retrieval.js";
import {
  questionTokens,
  validateDraft,
  formatQuotedAnswer,
  suspicious,
  type Evidence,
} from "./grounding.js";
import { runRagWorkflow } from "./workflow.js";
import { summarizeQuestions, type Memory } from "./memory.js";
import type { Generator } from "./generation.js";
export function withOwner<T>(
  pool: Pool,
  identity: Identity,
  work: (client: PoolClient) => Promise<T>,
) {
  return withTenant(pool, identity.tenantId, async (client) => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [
      identity.id,
    ]);
    return work(client);
  });
}
export type ChatScope = {
  policyId: string;
  comparisonPolicyId?: string;
  asOfDate: string;
  versionIds?: string[];
};
export type ChatAnswer = ReturnType<typeof validateDraft> & {
  id: string;
  conversationId: string;
  asOfDate: string;
  model: string;
  processingTimeMs: number;
  usedHistory: boolean;
  comparison?: {
    policyId: string;
    policyName: string;
    insufficientEvidence: boolean;
    conflict: boolean;
  }[];
  tokenUsage: { inputTokens: number; outputTokens: number };
};
export interface ChatServices {
  pool: Pool;
  vault: Vault;
  embedder: Embedder;
  generator: Generator;
  logger: Logger;
  contextBudget: number;
  topK: number;
  retrievalMode?: "semantic" | "hybrid";
  rerank?: boolean;
  candidateK?: number;
}
export class ChatService {
  constructor(private services: ChatServices) {}
  private transaction<T>(
    identity: Identity,
    work: (client: PoolClient) => Promise<T>,
  ) {
    return withOwner(this.services.pool, identity, work);
  }
  async create(identity: Identity, scope: ChatScope, requestId: string) {
    return this.transaction(identity, async (client) => {
      const policy = await client.query(
        "SELECT id FROM policies WHERE tenant_id=$1 AND id=$2",
        [identity.tenantId, scope.policyId],
      );
      if (!policy.rowCount) throw new AppError("POLICY_NOT_FOUND", 404);
      if (scope.comparisonPolicyId) {
        if (
          scope.comparisonPolicyId === scope.policyId ||
          scope.versionIds?.length
        )
          throw new AppError("INVALID_COMPARISON_SCOPE", 400);
        const other = await client.query(
          "SELECT id FROM policies WHERE tenant_id=$1 AND id=$2",
          [identity.tenantId, scope.comparisonPolicyId],
        );
        if (!other.rowCount) throw new AppError("POLICY_NOT_FOUND", 404);
      }
      if (scope.versionIds?.length) {
        const versions = await client.query(
          "SELECT v.id FROM document_versions v JOIN documents d ON d.id=v.document_id AND d.tenant_id=v.tenant_id WHERE v.tenant_id=$1 AND d.policy_id=$2 AND v.id=ANY($3::uuid[]) AND v.status <> 'ARCHIVED' AND d.deleted_at IS NULL",
          [identity.tenantId, scope.policyId, scope.versionIds],
        );
        if (versions.rowCount !== new Set(scope.versionIds).size)
          throw new AppError("VERSION_NOT_FOUND", 404);
      }
      const result = await client.query(
        `INSERT INTO conversations(tenant_id,user_id,policy_id,as_of_date,version_ids,comparison_policy_id,expires_at)
        SELECT $1,$2,$3,$4,$5,$6,now()+conversation_retention_days*interval '1 day' FROM tenants WHERE id=$1 RETURNING id,policy_id,comparison_policy_id,as_of_date::text,version_ids,created_at,expires_at`,
        [
          identity.tenantId,
          identity.id,
          scope.policyId,
          scope.asOfDate,
          scope.versionIds ?? null,
          scope.comparisonPolicyId ?? null,
        ],
      );
      await this.audit(
        client,
        identity,
        requestId,
        "conversation.created",
        result.rows[0].id,
      );
      return result.rows[0];
    });
  }
  async list(identity: Identity) {
    return this.transaction(
      identity,
      async (c) =>
        (
          await c.query(
            "SELECT c.id,c.policy_id,c.comparison_policy_id,other.name AS comparison_policy_name,c.as_of_date::text,c.version_ids,c.created_at,c.updated_at,c.expires_at,p.name AS policy_name FROM conversations c JOIN policies p ON p.id=c.policy_id AND p.tenant_id=c.tenant_id LEFT JOIN policies other ON other.id=c.comparison_policy_id AND other.tenant_id=c.tenant_id WHERE c.user_id=$1 AND c.expires_at>now() ORDER BY c.updated_at DESC LIMIT 50",
            [identity.id],
          )
        ).rows,
    );
  }
  async detail(identity: Identity, id: string) {
    return this.transaction(identity, async (c) => {
      const conversation = await this.owned(c, identity, id);
      const messages = await c.query(
        "SELECT id,role,content,content_encrypted,created_at FROM chat_messages WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at,id LIMIT 200",
        [identity.tenantId, id],
      );
      return {
        ...Object.fromEntries(
          Object.entries(conversation).filter(
            ([key]) => !key.startsWith("memory_"),
          ),
        ),
        messages: messages.rows.map((m) => ({
          id: m.id,
          role: m.role,
          createdAt: m.created_at,
          ...(m.content_encrypted
            ? JSON.parse(
                this.services.vault.openText(
                  m.content,
                  `${identity.tenantId}:${m.id}:chat`,
                ),
              )
            : { answer: m.content }),
        })),
      };
    });
  }
  private async owned(
    c: PoolClient,
    identity: Identity,
    id: string,
    lock = false,
  ) {
    const row = (
      await c.query(
        `SELECT id,policy_id,comparison_policy_id,memory_encrypted,memory_revision,as_of_date::text,version_ids,created_at,expires_at FROM conversations WHERE tenant_id=$1 AND id=$2 AND user_id=$3 AND expires_at>now() ${lock ? "FOR UPDATE" : ""}`,
        [identity.tenantId, id, identity.id],
      )
    ).rows[0];
    if (!row) throw new AppError("CONVERSATION_NOT_FOUND", 404);
    return row;
  }
  private audit(
    c: PoolClient,
    identity: Identity,
    requestId: string,
    action: string,
    resourceId: string,
  ) {
    return c.query(
      "INSERT INTO audit_logs(tenant_id,actor_id,action,resource_id,request_id) VALUES($1,$2,$3,$4,$5)",
      [identity.tenantId, identity.id, action, resourceId, requestId],
    );
  }
  async answer(
    identity: Identity,
    conversationId: string,
    question: string,
    requestKey: string,
    requestId: string,
    signal: AbortSignal,
    status: (stage: string) => void,
    authorize: () => Promise<void> = async () => undefined,
  ): Promise<ChatAnswer> {
    if (questionTokens(question) > 512)
      throw new AppError("QUESTION_TOO_LONG", 400);
    const { vault, pool, embedder, generator, logger } = this.services;
    const start = performance.now(),
      fingerprint = vault.fingerprint(
        question,
        `${identity.tenantId}:${conversationId}:request`,
      );
    const reserved = await this.transaction(identity, async (c) => {
      const conversation = await this.owned(c, identity, conversationId, true);
      if (!conversation.policy_id || !conversation.as_of_date)
        throw new AppError("CONVERSATION_SCOPE_REQUIRED", 409);
      await c.query(
        "UPDATE chat_runs SET status='FAILED',error_code='CHAT_INTERRUPTED' WHERE conversation_id=$1 AND status='RUNNING' AND lease_until<=now()",
        [conversationId],
      );
      const prior = (
        await c.query(
          "SELECT * FROM chat_runs WHERE conversation_id=$1 AND request_key=$2",
          [conversationId, requestKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== fingerprint)
          throw new AppError("IDEMPOTENCY_CONFLICT", 409);
        if (prior.status === "COMPLETED")
          return {
            conversation,
            replay: JSON.parse(
              vault.openText(
                prior.response_encrypted,
                `${identity.tenantId}:${prior.id}:response`,
              ),
            ) as ChatAnswer,
            runId: prior.id as string,
          };
        throw new AppError(
          prior.status === "RUNNING"
            ? "CHAT_ALREADY_RUNNING"
            : "CHAT_RETRY_WITH_NEW_KEY",
          409,
        );
      }
      if (
        (
          await c.query(
            "SELECT 1 FROM chat_runs WHERE conversation_id=$1 AND status='RUNNING'",
            [conversationId],
          )
        ).rowCount
      )
        throw new AppError("CHAT_ALREADY_RUNNING", 409);
      if (
        Number(
          (
            await c.query(
              "SELECT count(*) FROM chat_messages WHERE conversation_id=$1",
              [conversationId],
            )
          ).rows[0].count,
        ) >= 200
      )
        throw new AppError("CONVERSATION_FULL", 409);
      const runId = randomUUID();
      await c.query(
        "INSERT INTO chat_runs(id,tenant_id,conversation_id,request_key,request_hash,status,lease_until) VALUES($1,$2,$3,$4,$5,'RUNNING',now()+interval '5 minutes')",
        [runId, identity.tenantId, conversationId, requestKey, fingerprint],
      );
      await this.audit(c, identity, requestId, "chat.started", runId);
      return { conversation, runId, replay: undefined };
    });
    if (reserved.replay) {
      await authorize();
      status("replayed");
      return reserved.replay;
    }
    const { runId, conversation } = reserved;
    try {
      signal.throwIfAborted();
      const scope = {
        policyId: conversation.policy_id as string,
        asOfDate: conversation.as_of_date as string,
        ...(conversation.version_ids
          ? { versionIds: conversation.version_ids as string[] }
          : {}),
      };
      const memory: Memory = conversation.memory_encrypted
        ? JSON.parse(
            vault.openText(
              conversation.memory_encrypted,
              `${identity.tenantId}:${conversationId}:memory`,
            ),
          )
        : await this.transaction(identity, async (c) => {
            await this.owned(c, identity, conversationId);
            const prior = await c.query(
              "SELECT id,content,content_encrypted FROM chat_messages WHERE conversation_id=$1 AND role='user' ORDER BY created_at DESC,id DESC LIMIT 6",
              [conversationId],
            );
            return summarizeQuestions(
              prior.rows.reverse().flatMap((m) => {
                if (!m.content_encrypted) return [];
                const payload = JSON.parse(
                  vault.openText(
                    m.content,
                    `${identity.tenantId}:${m.id}:chat`,
                  ),
                );
                return typeof payload.question === "string"
                  ? [payload.question]
                  : [];
              }),
            );
          });
      const policyIds = [
        scope.policyId,
        ...(conversation.comparison_policy_id
          ? [conversation.comparison_policy_id as string]
          : []),
      ];
      const runs: {
        policyId: string;
        policyName: string;
        workflow: Awaited<ReturnType<typeof runRagWorkflow>>;
        retrieved: Awaited<ReturnType<typeof searchIndex>>;
      }[] = [];
      for (const policyId of policyIds) {
        let retrieved: Awaited<ReturnType<typeof searchIndex>> | undefined;
        const workflow = await runRagWorkflow({
          question,
          memory,
          budget: this.services.contextBudget,
          generator,
          signal,
          status,
          retrieve: async (query) => {
            retrieved = await searchIndex(
              pool,
              embedder,
              vault,
              identity.tenantId,
              {
                ...scope,
                policyId,
                question: query,
                topK: this.services.topK,
                mode: this.services.retrievalMode ?? "hybrid",
                rerank: this.services.rerank ?? true,
                candidateK: this.services.candidateK ?? 20,
              },
              signal,
            );
            return retrieved.matches;
          },
        });
        if (!retrieved) throw new AppError("CHAT_FAILED", 503);
        const policyName = await this.transaction(
          identity,
          async (c) =>
            (
              await c.query(
                "SELECT name FROM policies WHERE tenant_id=$1 AND id=$2",
                [identity.tenantId, policyId],
              )
            ).rows[0]?.name as string,
        );
        runs.push({ policyId, policyName, workflow, retrieved });
      }
      const first = runs[0]!;
      let result = first.workflow.result;
      const inputTokens = runs.reduce((n, r) => n + r.workflow.inputTokens, 0),
        outputTokens = runs.reduce((n, r) => n + r.workflow.outputTokens, 0);
      if (runs.length === 2) {
        let offset = 0;
        const parts = runs.map((r) => {
          const local = r.workflow.result;
          const citations = local.citations.map((c) => ({
            ...c,
            number: c.number + offset,
            policyId: r.policyId,
            policyName: r.policyName,
          }));
          const text = citations.length
            ? formatQuotedAnswer(citations, local.conflict)
            : local.answer;
          offset += citations.length;
          return { text: `${r.policyName}\n${text}`, citations };
        });
        result = {
          answer: parts.map((p) => p.text).join("\n\n"),
          citations: parts.flatMap((p) => p.citations),
          insufficientEvidence: runs.some(
            (r) => r.workflow.result.insufficientEvidence,
          ),
          conflict: runs.some((r) => r.workflow.result.conflict),
          grounding: parts.some((p) => p.citations.length)
            ? "verified_quotes"
            : "abstained",
        };
      }
      signal.throwIfAborted();
      // Verify applicability again after generation, before publishing any text.
      // A concurrent archive/supersession invalidates the answer; no stale answer is saved.
      const answer: ChatAnswer = {
        ...result,
        id: randomUUID(),
        conversationId,
        asOfDate: scope.asOfDate,
        model: generator.model,
        usedHistory: runs.some((r) => r.workflow.usedHistory),
        ...(runs.length === 2
          ? {
              comparison: runs.map((r) => ({
                policyId: r.policyId,
                policyName: r.policyName,
                insufficientEvidence: r.workflow.result.insufficientEvidence,
                conflict: r.workflow.result.conflict,
              })),
            }
          : {}),
        processingTimeMs: Math.round(performance.now() - start),
        tokenUsage: { inputTokens, outputTokens },
      };
      await authorize();
      await this.transaction(identity, async (c) => {
        await this.owned(c, identity, conversationId, true);
        for (const r of [...runs].sort((a, b) =>
          a.policyId.localeCompare(b.policyId),
        ))
          await this.validateSources(
            c,
            identity,
            { ...scope, policyId: r.policyId },
            r.workflow.context.evidence,
            r.retrieved.versionSnapshot,
          );
        const run = await c.query(
          "SELECT id FROM chat_runs WHERE id=$1 AND status='RUNNING' AND lease_until>now() FOR UPDATE",
          [runId],
        );
        if (!run.rowCount) throw new AppError("CHAT_INTERRUPTED", 409);
        signal.throwIfAborted();
        const userId = randomUUID();
        await c.query(
          `INSERT INTO chat_messages(id,tenant_id,conversation_id,run_id,role,content,content_encrypted,created_at)
          VALUES($1,$2,$3,$4,'user',$5,true,clock_timestamp()),($6,$2,$3,$4,'assistant',$7,true,clock_timestamp()+interval '1 microsecond')`,
          [
            userId,
            identity.tenantId,
            conversationId,
            runId,
            vault.sealText(
              JSON.stringify({ question }),
              `${identity.tenantId}:${userId}:chat`,
            ),
            answer.id,
            vault.sealText(
              JSON.stringify(answer),
              `${identity.tenantId}:${answer.id}:chat`,
            ),
          ],
        );
        await c.query(
          "UPDATE chat_messages SET input_tokens=$2,output_tokens=$3,insufficient_evidence=$4 WHERE id=$1",
          [answer.id, inputTokens, outputTokens, result.insufficientEvidence],
        );
        await c.query(
          "UPDATE chat_runs SET status='COMPLETED',response_encrypted=$2 WHERE id=$1",
          [
            runId,
            vault.sealText(
              JSON.stringify(answer),
              `${identity.tenantId}:${runId}:response`,
            ),
          ],
        );
        const nextMemory = summarizeQuestions([...memory.questions, question]);
        // Keep only a bounded resolved question as topic, never an assistant answer.
        if (
          questionTokens(first.workflow.query) <= 160 &&
          !suspicious(first.workflow.query)
        )
          nextMemory.topic = first.workflow.query;
        await c.query(
          "UPDATE conversations SET updated_at=now(),memory_encrypted=$2,memory_revision=memory_revision+1 WHERE id=$1",
          [
            conversationId,
            vault.sealText(
              JSON.stringify(nextMemory),
              `${identity.tenantId}:${conversationId}:memory`,
            ),
          ],
        );
        await this.audit(c, identity, requestId, "chat.completed", runId);
      });
      chatResults.inc({
        outcome: answer.insufficientEvidence ? "abstained" : "answered",
      });
      contextTokens.observe(
        runs.reduce((n, r) => n + r.workflow.context.tokens, 0),
      );
      logger.info(
        {
          requestId,
          tenantId: identity.tenantId,
          operation: "rag_query",
          runId,
          durationMs: answer.processingTimeMs,
          inputTokens,
          outputTokens,
          contextTokens: runs.reduce(
            (n, r) => n + r.workflow.context.tokens,
            0,
          ),
          usedHistory: answer.usedHistory,
          retrievalMode: this.services.retrievalMode ?? "hybrid",
          comparedPolicyCount: runs.length,
          retrievedChunkCount: runs.reduce(
            (n, r) => n + r.workflow.context.evidence.length,
            0,
          ),
          citationCount: answer.citations.length,
          insufficientEvidence: answer.insufficientEvidence,
        },
        "chat_completed",
      );
      return answer;
    } catch (error) {
      const code = signal.aborted
        ? "CHAT_CANCELLED"
        : error instanceof AppError
          ? error.code
          : "CHAT_FAILED";
      await this.transaction(identity, async (c) => {
        await c.query(
          "UPDATE chat_runs SET status='FAILED',error_code=$2 WHERE id=$1 AND status='RUNNING'",
          [runId, code],
        );
        await this.audit(c, identity, requestId, "chat.failed", runId);
      }).catch(() =>
        logger.error({ requestId, runId }, "chat_failure_persistence_failed"),
      );
      chatResults.inc({ outcome: signal.aborted ? "cancelled" : "failed" });
      logger.warn(
        {
          requestId,
          tenantId: identity.tenantId,
          operation: "rag_query",
          runId,
          errorCode: code,
          durationMs: Math.round(performance.now() - start),
        },
        "chat_failed",
      );
      throw error instanceof AppError
        ? error
        : new AppError(code, signal.aborted ? 499 : 503);
    }
  }
  private async validateSources(
    c: PoolClient,
    identity: Identity,
    scope: ChatScope,
    evidence: Evidence[],
    snapshot: { id: string; generation: string | null }[],
  ) {
    await c.query(
      "SELECT id FROM policies WHERE tenant_id=$1 AND id=$2 FOR SHARE",
      [identity.tenantId, scope.policyId],
    );
    const rows = (
      await c.query(
        `SELECT v.id,v.document_id,v.version,v.effective_from::text,v.effective_to::text,v.supersedes_id,v.status,v.active_generation_id,v.embedding_model,v.scan_status FROM document_versions v JOIN documents d ON d.id=v.document_id AND d.tenant_id=v.tenant_id WHERE v.tenant_id=$1 AND d.policy_id=$2 AND d.deleted_at IS NULL FOR SHARE OF v`,
        [identity.tenantId, scope.policyId],
      )
    ).rows;
    const current = applicableVersions(rows, scope.asOfDate, scope.versionIds);
    // Recheck all chunks, not only cited ones: new evidence can change a conflict/abstention decision.
    const chunkIds = [...new Set(evidence.map((e) => e.chunkId))];
    const valid = await c.query(
      "SELECT id FROM document_chunks WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND generation_id=ANY($3::uuid[])",
      [
        identity.tenantId,
        chunkIds,
        current.map((v) => v.active_generation_id).filter(Boolean),
      ],
    );
    if (
      valid.rowCount !== chunkIds.length ||
      current.some((v) => !v.active_generation_id || v.scan_status !== "CLEAN")
    )
      throw new AppError("VERSION_CHANGED_RETRY", 409);
    if (
      current.length !== snapshot.length ||
      current.some(
        (v) =>
          snapshot.find((s) => s.id === v.id)?.generation !==
          v.active_generation_id,
      )
    )
      throw new AppError("VERSION_CHANGED_RETRY", 409);
  }
}
