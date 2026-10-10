import { observed } from "../../observability/src/telemetry.js";
import {
  keywordQuery,
  KEYWORD_PROFILE,
} from "../../ai/src/retrieval/keywords.js";
import {
  reciprocalRankFusion,
  localReranker,
} from "../../ai/src/retrieval/ranking.js";
import type { Pool } from "pg";
import { withTenant } from "../../database/src/tenant.js";
import { AppError } from "../../shared/src/errors.js";
import type { Embedder } from "../../ai/src/embeddings.js";
import type { Vault } from "../../security/src/crypto.js";
export interface RetrievalMatch {
  chunkId: string;
  text: string;
  documentId: string;
  documentName: string;
  versionId: string;
  version: number;
  source: Record<string, unknown>;
  distance: number;
  policyId?: string;
  policyName?: string;
  fusionScore?: number;
  rerankScore?: number;
  semanticRank?: number;
  keywordRank?: number;
}
export interface VersionCandidate {
  id: string;
  document_id: string;
  version: number;
  effective_from: string | null;
  effective_to: string | null;
  supersedes_id: string | null;
  status: string;
  active_generation_id: string | null;
  embedding_model: string | null;
  scan_status: string;
}
export function applicableVersions(
  rows: VersionCandidate[],
  asOf: string,
  explicit?: string[],
): VersionCandidate[] {
  const available = rows.filter(
    (v) => v.status !== "ARCHIVED" && v.status !== "PENDING_UPLOAD",
  );
  if (explicit?.length) {
    const selected = explicit.map((id) => available.find((v) => v.id === id));
    if (selected.some((v) => !v)) throw new AppError("VERSION_NOT_FOUND", 404);
    return selected as VersionCandidate[];
  }
  const effective = available.filter(
    (v) =>
      v.effective_from &&
      v.effective_from <= asOf &&
      (!v.effective_to || v.effective_to >= asOf),
  );
  // An undated version requires an explicit choice; do not silently omit it.
  if (available.some((v) => !v.effective_from))
    throw new AppError("VERSION_CLARIFICATION_REQUIRED", 409);
  const superseded = new Set<string>();
  const all = new Map(rows.map((v) => [v.id, v]));
  // Supersession is permanent after its effective start. Archiving or expiry is not a rollback.
  const supersessionSources = rows.filter(
    (v) =>
      v.status !== "PENDING_UPLOAD" &&
      v.effective_from &&
      v.effective_from <= asOf,
  );
  for (const row of supersessionSources) {
    let previous = row.supersedes_id;
    const seen = new Set<string>();
    while (previous && !seen.has(previous)) {
      seen.add(previous);
      superseded.add(previous);
      previous = all.get(previous)?.supersedes_id ?? null;
    }
  }
  const selected = effective.filter((v) => !superseded.has(v.id));
  const documents = new Set<string>();
  for (const version of selected) {
    if (documents.has(version.document_id))
      throw new AppError("VERSION_CLARIFICATION_REQUIRED", 409);
    documents.add(version.document_id);
  }
  return selected;
}
async function searchIndexInternal(
  pool: Pool,
  embedder: Embedder,
  vault: Vault,
  tenantId: string,
  query: {
    question: string;
    policyId: string;
    asOfDate: string;
    versionIds?: string[];
    topK: number;
    mode?: "semantic" | "hybrid" | "keyword";
    rerank?: boolean;
    candidateK?: number;
  },
  signal?: AbortSignal,
) {
  // Resolve authorization and applicability before sending any question to an embedder.
  const selected = await withTenant(pool, tenantId, async (client) => {
    const policy = await client.query(
      "SELECT id FROM policies WHERE tenant_id=$1 AND id=$2",
      [tenantId, query.policyId],
    );
    if (!policy.rowCount) throw new AppError("POLICY_NOT_FOUND", 404);
    const rows = (
      await client.query(
        `SELECT v.id,v.document_id,v.version,v.effective_from::text,v.effective_to::text,v.supersedes_id,v.status,v.active_generation_id,v.embedding_model,v.scan_status
      FROM document_versions v JOIN documents d ON d.id=v.document_id AND d.tenant_id=v.tenant_id WHERE v.tenant_id=$1 AND d.policy_id=$2 AND d.deleted_at IS NULL ORDER BY v.document_id,v.version`,
        [tenantId, query.policyId],
      )
    ).rows as VersionCandidate[];
    const versions = applicableVersions(rows, query.asOfDate, query.versionIds);
    for (const v of versions) {
      if (!v.active_generation_id || v.scan_status !== "CLEAN")
        throw new AppError("APPLICABLE_VERSION_NOT_INDEXED", 409);
    }
    return versions;
  });
  if (!selected.length)
    return {
      versionSnapshot: [] as { id: string; generation: string | null }[],
      matches: [] as RetrievalMatch[],
      diagnostics: {
        semanticCandidates: 0,
        keywordCandidates: 0,
        keywordReady: true,
        mode: query.mode ?? "hybrid",
        reranker: query.rerank === false ? null : localReranker.name,
      },
      insufficientEvidence: true,
      asOfDate: query.asOfDate,
    };
  const semanticVersions = selected.filter(
    (v) => v.embedding_model === embedder.model,
  );
  // Existing profiles retain keyword retrieval without changing their embeddings.
  const mode =
    query.mode === "keyword" || !semanticVersions.length
      ? "keyword"
      : semanticVersions.length !== selected.length
        ? "hybrid"
        : (query.mode ?? "hybrid");
  const embedded =
    mode === "keyword"
      ? undefined
      : await (embedder.embedQuery
          ? embedder.embedQuery(tenantId, query.question, signal)
          : embedder.embed([query.question], "query", signal));
  return observed("retrieval.database", () =>
    withTenant(pool, tenantId, async (client) => {
      // Block new reservations while rechecking every version, including newly completed uploads.
      await client.query("SELECT id FROM policies WHERE id=$1 FOR SHARE", [
        query.policyId,
      ]);
      const all = (
        await client.query(
          `SELECT v.id,v.document_id,v.version,v.effective_from::text,v.effective_to::text,v.supersedes_id,v.status,v.active_generation_id,v.embedding_model,v.scan_status
      FROM document_versions v JOIN documents d ON d.id=v.document_id AND d.tenant_id=v.tenant_id WHERE v.tenant_id=$1 AND d.policy_id=$2 AND d.deleted_at IS NULL FOR SHARE OF v`,
          [tenantId, query.policyId],
        )
      ).rows as VersionCandidate[];
      const current = applicableVersions(all, query.asOfDate, query.versionIds);
      if (
        current.length !== selected.length ||
        current.some(
          (v) =>
            v.scan_status !== "CLEAN" ||
            v.active_generation_id !==
              selected.find((s) => s.id === v.id)?.active_generation_id,
        )
      )
        throw new AppError("VERSION_CHANGED_RETRY", 409);
      const base = `SELECT c.id,c.content,c.metadata,c.version_id,c.embedding<=>$3::vector AS distance,d.id AS document_id,d.name AS document_name,v.version,p.name AS policy_name
      FROM document_chunks c JOIN document_versions v ON v.id=c.version_id AND v.tenant_id=c.tenant_id AND v.active_generation_id=c.generation_id
      JOIN documents d ON d.id=v.document_id AND d.tenant_id=v.tenant_id
      JOIN policies p ON p.id=d.policy_id AND p.tenant_id=d.tenant_id
      WHERE c.tenant_id=$1 AND c.version_id=ANY($2::uuid[]) AND c.embedding_model=$4 AND c.embedding_dimensions=$5 AND v.status<>'ARCHIVED' AND d.deleted_at IS NULL`;
      const candidateK = Math.min(
        40,
        Math.max(query.topK, query.candidateK ?? 20),
      );
      const params = [
        tenantId,
        semanticVersions.map((v) => v.id),
        JSON.stringify(embedded?.vectors[0]),
        embedder.model,
        embedder.dimensions,
        candidateK,
      ];
      const semantic =
        mode === "keyword"
          ? []
          : (
              await client.query(
                `${base} ORDER BY c.embedding<=>$3::vector,c.id LIMIT $6`,
                params,
              )
            ).rows;
      const lexemes = keywordQuery(query.question, tenantId, vault);
      const keyword =
        mode === "semantic" || !lexemes
          ? []
          : (
              await client.query(
                `SELECT c.id,c.content,c.metadata,c.version_id,1::float AS distance,d.id AS document_id,d.name AS document_name,v.version,p.name AS policy_name
                 FROM document_chunks c JOIN document_versions v ON v.id=c.version_id AND v.tenant_id=c.tenant_id AND v.active_generation_id=c.generation_id
                 JOIN documents d ON d.id=v.document_id AND d.tenant_id=v.tenant_id
                 JOIN policies p ON p.id=d.policy_id AND p.tenant_id=d.tenant_id
                 WHERE c.tenant_id=$1 AND c.version_id=ANY($2::uuid[]) AND v.status<>'ARCHIVED' AND d.deleted_at IS NULL
                 AND c.keyword_profile=$3 AND c.keyword_vector @@ $4::tsquery
                 ORDER BY ts_rank_cd(c.keyword_vector,$4::tsquery,32) DESC,c.id LIMIT $5`,
                [
                  tenantId,
                  selected.map((v) => v.id),
                  KEYWORD_PROFILE,
                  lexemes,
                  candidateK,
                ],
              )
            ).rows;
      const keywordReady = !(
        await client.query(
          `SELECT 1 FROM document_chunks c JOIN document_versions v ON v.id=c.version_id AND v.tenant_id=c.tenant_id AND v.active_generation_id=c.generation_id WHERE c.tenant_id=$1 AND c.version_id=ANY($2::uuid[]) AND c.keyword_profile IS DISTINCT FROM $3 LIMIT 1`,
          [tenantId, selected.map((v) => v.id), KEYWORD_PROFILE],
        )
      ).rowCount;
      const fused =
        mode === "hybrid"
          ? reciprocalRankFusion(semantic, keyword)
          : mode === "keyword"
            ? keyword
            : semantic;
      const decoded: RetrievalMatch[] = fused.map((r) => ({
        chunkId: r.id,
        text: vault.openText(r.content, `${tenantId}:${r.id}`),
        documentId: r.document_id,
        documentName: r.document_name,
        versionId: r.version_id,
        version: r.version,
        source: JSON.parse(
          vault.openText(r.metadata.encrypted, `${tenantId}:${r.id}:metadata`),
        ),
        distance: Number(r.distance),
        policyId: query.policyId,
        policyName: r.policy_name,
        fusionScore: r.fusionScore,
        semanticRank: r.semanticRank,
        keywordRank: r.keywordRank,
      }));
      const ranked =
        query.rerank === false
          ? decoded
          : localReranker.rank(query.question, decoded);
      const matches = ranked.slice(0, query.topK);

      return {
        versionSnapshot: selected.map((v) => ({
          id: v.id,
          generation: v.active_generation_id,
        })),
        matches,
        diagnostics: {
          semanticCandidates: semantic.length,
          keywordCandidates: keyword.length,
          keywordReady,
          mode,
          reranker: query.rerank === false ? null : localReranker.name,
        },
        insufficientEvidence: matches.length === 0,
        asOfDate: query.asOfDate,
      };
    }),
  );
}

export function searchIndex(...args: Parameters<typeof searchIndexInternal>) {
  return observed("retrieval.search", () => searchIndexInternal(...args));
}
