import { traceCarrier } from "../../../../packages/observability/src/telemetry.js";
import { chatRouter } from "./chat.js";
import {
  withOwner,
  type ChatService,
} from "../../../../packages/chat/src/service.js";
import { Router, raw, json, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import {
  Authentication,
  requireAdmin,
  type Identity,
} from "../../../../packages/security/src/auth.js";
import { hash, type Vault } from "../../../../packages/security/src/crypto.js";
import { withTenant } from "../../../../packages/database/src/tenant.js";
import { AppError } from "../../../../packages/shared/src/errors.js";
import {
  fileType,
  validateBytes,
  MAX_UPLOAD_BYTES,
} from "../../../../packages/document-processing/src/validate.js";
import type { ObjectStorage } from "../../../../packages/ingestion/src/storage.js";
import type { Embedder } from "../../../../packages/ai/src/embeddings.js";
import { searchIndex } from "../../../../packages/ingestion/src/retrieval.js";
export interface IngestionApi {
  chat?: ChatService;
  pool: Pool;
  auth: Authentication;
  storage: ObjectStorage;
  embedder: Embedder;
  vault: Vault;
  origins: string[];
  authMode: string;
}
const uuid = z.uuid();
const date = z.iso.date();
const uploadSchema = z
  .object({
    policyId: uuid,
    documentId: uuid.optional(),
    documentType: z
      .enum(["policy", "rider", "brochure", "terms"])
      .default("policy"),
    fileName: z.string().min(1).max(200),
    mimeType: z.string().max(150),
    sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    effectiveFrom: date,
    effectiveTo: date.optional(),
    supersedesId: uuid.optional(),
  })
  .strict()
  .refine(
    (v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom,
    "Invalid effective range",
  );
const audit = async (
  client: PoolClient,
  user: Identity,
  requestId: string,
  action: string,
  resourceId?: string,
) =>
  client.query(
    "INSERT INTO audit_logs(tenant_id,actor_id,action,resource_id,request_id) VALUES($1,$2,$3,$4,$5)",
    [user.tenantId, user.id, action, resourceId ?? null, requestId],
  );
const requestId = (res: Response) => String(res.getHeader("X-Request-Id"));
const user = (res: Response) => res.locals.identity as Identity;
async function queue(
  client: PoolClient,
  versionId: string,
  identity: Identity,
  res: Response,
  key?: string,
) {
  if (key) {
    const prior = (
      await client.query(
        "SELECT id,generation_id,status FROM ingestion_jobs WHERE version_id=$1 AND request_key=$2",
        [versionId, key],
      )
    ).rows[0];
    if (prior) return prior;
  }
  const active = (
    await client.query(
      "SELECT id,generation_id,status,request_key FROM ingestion_jobs WHERE tenant_id=$1 AND version_id=$2 AND status IN ('PENDING','RUNNING')",
      [identity.tenantId, versionId],
    )
  ).rows[0];
  if (active) {
    if (key && active.request_key !== key)
      throw new AppError("INGESTION_ALREADY_RUNNING", 409);
    return active;
  }
  const id = randomUUID(),
    generation = randomUUID();
  await client.query(
    "INSERT INTO ingestion_jobs(id,tenant_id,version_id,generation_id,request_id,request_key,trace_parent) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      id,
      identity.tenantId,
      versionId,
      generation,
      requestId(res),
      key ?? null,
      traceCarrier(),
    ],
  );
  await client.query(
    "UPDATE document_versions SET status='UPLOADED',failure_code=NULL WHERE id=$1",
    [versionId],
  );
  await audit(client, identity, requestId(res), "ingestion.queued", versionId);
  return { id, generation_id: generation, status: "PENDING" };
}
export function ingestionRouter(services: IngestionApi) {
  const { pool, auth, storage, embedder, vault, origins } = services;
  const router = Router();
  router.use((req, _res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !/^Bearer (\S+)$/.test(req.headers.authorization ?? "")
    ) {
      if (!req.headers.origin || !origins.includes(req.headers.origin))
        throw new AppError("ORIGIN_NOT_ALLOWED", 403);
    }
    next();
  });
  router.use(json({ limit: "32kb" }));
  router.get("/auth/config", (_req, res) =>
    res.json({ mode: services.authMode }),
  );
  router.post(
    "/auth/login",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 20,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({
          error: {
            code: "RATE_LIMITED",
            message: "Try again later",
            requestId: requestId(res),
          },
        }),
    }),
    async (req, res) => {
      const body = z
        .object({
          email: z.email().max(254),
          password: z.string().min(1).max(200),
        })
        .strict()
        .parse(req.body);
      const result = await auth.login(body.email, body.password);
      await withTenant(pool, result.user.tenantId, (client) =>
        audit(client, result.user, requestId(res), "auth.login"),
      );
      res.cookie("advisor_session", result.token, {
        httpOnly: true,
        sameSite: "strict",
        secure: false,
        maxAge: 3600000,
        path: "/",
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ user: result.user });
    },
  );
  router.use(async (req, res, next) => {
    res.locals.identity = await auth.authenticate(req);
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (_req, res) => user(res).id,
      handler: (_req, res) =>
        res.status(429).json({
          error: {
            code: "RATE_LIMITED",
            message: "Try again later",
            requestId: requestId(res),
          },
        }),
    }),
  );
  router.use((_req, res, next) => {
    res.locals.auditDenial = async () =>
      withTenant(pool, user(res).tenantId, (client) =>
        audit(client, user(res), requestId(res), "access.denied"),
      );
    next();
  });
  router.get("/admin/audit-logs", async (req, res) => {
    requireAdmin(user(res));
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        before: z.iso.datetime({ offset: true }).optional(),
      })
      .strict()
      .parse(req.query);
    const items = await withTenant(pool, user(res).tenantId, async (client) => {
      await audit(client, user(res), requestId(res), "audit.viewed");
      return (
        await client.query(
          "SELECT id,actor_id,action,resource_id,request_id,created_at FROM audit_logs WHERE ($2::timestamptz IS NULL OR created_at<$2) ORDER BY created_at DESC,id DESC LIMIT $1",
          [query.limit, query.before ?? null],
        )
      ).rows;
    });
    res.json({ items });
  });
  router.get("/auth/me", (_req, res) => res.json({ user: user(res) }));
  router.post("/auth/logout", async (req, res) => {
    await auth.logout(req, user(res), requestId(res));
    res.clearCookie("advisor_session", {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
    res.status(204).end();
  });
  router.get("/policies", async (_req, res) =>
    res.json({
      items: await withTenant(
        pool,
        user(res).tenantId,
        async (client) =>
          (
            await client.query(
              "SELECT id,name,provider FROM policies ORDER BY created_at DESC LIMIT 100",
            )
          ).rows,
      ),
    }),
  );
  router.post("/policies", async (req, res) => {
    const identity = user(res);
    requireAdmin(identity);
    const body = z
      .object({
        name: z.string().trim().min(1).max(200),
        provider: z.string().trim().min(1).max(200),
      })
      .strict()
      .parse(req.body);
    const policy = await withTenant(pool, identity.tenantId, async (client) => {
      const row = (
        await client.query(
          "INSERT INTO policies(tenant_id,name,provider) VALUES($1,$2,$3) RETURNING id,name,provider",
          [identity.tenantId, body.name, body.provider],
        )
      ).rows[0];
      await audit(client, identity, requestId(res), "policy.created", row.id);
      return row;
    });
    res.status(201).json(policy);
  });
  router.post("/documents/upload-url", async (req, res) => {
    const identity = user(res);
    requireAdmin(identity);
    const body = uploadSchema.parse(req.body);
    fileType(body.fileName, body.mimeType);
    const key = uuid.parse(req.get("Idempotency-Key"));
    const requestHash = hash(JSON.stringify(body));
    const result = await withTenant(pool, identity.tenantId, async (client) => {
      // Same-policy lock serializes version numbering and idempotent reservation races.
      const policy = await client.query(
        "SELECT id FROM policies WHERE id=$1 FOR UPDATE",
        [body.policyId],
      );
      if (!policy.rowCount) throw new AppError("POLICY_NOT_FOUND", 404);
      const existing = (
        await client.query(
          "SELECT id,document_id,upload_request_hash,upload_expires_at,status FROM document_versions WHERE uploaded_by=$1 AND upload_idempotency_key=$2",
          [identity.id, key],
        )
      ).rows[0];
      if (existing) {
        if (existing.upload_request_hash !== requestHash)
          throw new AppError("IDEMPOTENCY_CONFLICT", 409);
        return existing;
      }
      let documentId = body.documentId;
      if (documentId) {
        const document = await client.query(
          "SELECT id FROM documents WHERE id=$1 AND policy_id=$2 AND deleted_at IS NULL FOR UPDATE",
          [documentId, body.policyId],
        );
        if (!document.rowCount) throw new AppError("DOCUMENT_NOT_FOUND", 404);
      } else {
        documentId = randomUUID();
        await client.query(
          "INSERT INTO documents(id,tenant_id,policy_id,name,document_type) VALUES($1,$2,$3,$4,$5)",
          [
            documentId,
            identity.tenantId,
            body.policyId,
            body.fileName,
            body.documentType,
          ],
        );
      }
      const version = Number(
        (
          await client.query(
            "SELECT coalesce(max(version),0)+1 AS version FROM document_versions WHERE document_id=$1",
            [documentId],
          )
        ).rows[0].version,
      );
      if (body.supersedesId) {
        const previous = await client.query(
          "SELECT id FROM document_versions WHERE id=$1 AND document_id=$2 AND status NOT IN ('PENDING_UPLOAD','ARCHIVED')",
          [body.supersedesId, documentId],
        );
        if (!previous.rowCount) throw new AppError("INVALID_SUPERSESSION", 409);
      }
      const id = randomUUID();
      const row = (
        await client.query(
          `INSERT INTO document_versions(id,tenant_id,document_id,version,s3_key,file_name,mime_type,size_bytes,content_hash,uploaded_by,effective_from,effective_to,supersedes_id,request_id,upload_idempotency_key,upload_request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id,document_id,upload_expires_at,status`,
          [
            id,
            identity.tenantId,
            documentId,
            version,
            `${identity.tenantId}/${id}`,
            body.fileName,
            body.mimeType,
            body.sizeBytes,
            body.sha256,
            identity.id,
            body.effectiveFrom,
            body.effectiveTo ?? null,
            body.supersedesId ?? null,
            requestId(res),
            key,
            requestHash,
          ],
        )
      ).rows[0];
      await audit(
        client,
        identity,
        requestId(res),
        "document.upload_reserved",
        id,
      );
      return row;
    });
    res.status(201).json({
      versionId: result.id,
      documentId: result.document_id,
      uploadUrl: `/api/v1/documents/uploads/${result.id}`,
      method: "PUT",
      requiredHeaders: { "Content-Type": body.mimeType },
      expiresAt: result.upload_expires_at,
      status: result.status,
    });
  });
  let inFlightUploads = 0;
  router.put(
    "/documents/uploads/:versionId",
    (req, res, next) => {
      requireAdmin(user(res));
      const length = Number(req.get("Content-Length"));
      if (!Number.isInteger(length) || length < 1 || length > MAX_UPLOAD_BYTES)
        throw new AppError("INVALID_FILE_SIZE", 413);
      if (inFlightUploads >= 4)
        throw new AppError("UPLOAD_CAPACITY_EXCEEDED", 429);
      inFlightUploads++;
      res.once("close", () => {
        inFlightUploads--;
      });
      next();
    },
    raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      const identity = user(res);
      const id = uuid.parse(req.params.versionId);
      const data = req.body as Buffer;
      if (!Buffer.isBuffer(data)) throw new AppError("BINARY_BODY_REQUIRED");
      await withTenant(pool, identity.tenantId, async (client) => {
        const version = (
          await client.query(
            "SELECT * FROM document_versions WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!version) throw new AppError("DOCUMENT_NOT_FOUND", 404);
        if (version.status !== "PENDING_UPLOAD")
          throw new AppError("UPLOAD_ALREADY_COMPLETED", 409);
        if (new Date(version.upload_expires_at).getTime() < Date.now())
          throw new AppError("UPLOAD_EXPIRED", 410);
        if (version.uploaded_by !== identity.id)
          throw new AppError("UPLOAD_OWNER_REQUIRED", 403);
        if (
          data.length !== Number(version.size_bytes) ||
          hash(data) !== version.content_hash
        )
          throw new AppError("UPLOAD_CHECKSUM_MISMATCH");
        if (req.get("Content-Type") !== version.mime_type)
          throw new AppError("MIME_MISMATCH", 415);
        await validateBytes(
          data,
          fileType(version.file_name, version.mime_type),
        );
        await storage.put(version.s3_key, data);
        await client.query(
          "UPDATE document_versions SET uploaded_at=coalesce(uploaded_at,now()) WHERE id=$1",
          [id],
        );
        await audit(
          client,
          identity,
          requestId(res),
          "document.bytes_received",
          id,
        );
      });
      res.status(204).end();
    },
  );
  router.post("/documents/complete-upload", async (req, res) => {
    const identity = user(res);
    requireAdmin(identity);
    const { versionId } = z
      .object({ versionId: uuid })
      .strict()
      .parse(req.body);
    const result = await withTenant(pool, identity.tenantId, async (client) => {
      const v = (
        await client.query(
          "SELECT * FROM document_versions WHERE id=$1 FOR UPDATE",
          [versionId],
        )
      ).rows[0];
      if (!v) throw new AppError("DOCUMENT_NOT_FOUND", 404);
      if (v.uploaded_by !== identity.id)
        throw new AppError("UPLOAD_OWNER_REQUIRED", 403);
      if (v.status === "ARCHIVED") throw new AppError("VERSION_ARCHIVED", 409);
      if (v.status !== "PENDING_UPLOAD")
        return (
          await client.query(
            "SELECT id,status FROM ingestion_jobs WHERE version_id=$1 ORDER BY created_at DESC LIMIT 1",
            [versionId],
          )
        ).rows[0];
      if (!v.uploaded_at) throw new AppError("UPLOAD_NOT_RECEIVED", 409);
      return queue(client, versionId, identity, res);
    });
    res
      .status(202)
      .json({ versionId, jobId: result?.id, status: result?.status });
  });
  router.get("/documents", async (req, res) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(10000).default(0),
        status: z
          .enum([
            "PENDING_UPLOAD",
            "UPLOADED",
            "PROCESSING",
            "INDEXED",
            "FAILED",
            "ARCHIVED",
          ])
          .optional(),
      })
      .parse(req.query);
    const items = await withTenant(
      pool,
      user(res).tenantId,
      async (client) =>
        (
          await client.query(
            `SELECT d.id AS document_id,d.policy_id,d.name,p.name AS policy_name,p.provider,v.id AS version_id,v.version,v.status,v.failure_code,v.scan_status,v.chunk_count,v.effective_from::text,v.effective_to::text,v.supersedes_id,v.created_at,v.indexed_at,v.embedding_model,
      (SELECT row_to_json(j) FROM (SELECT id,status,attempts,processed_chunks,input_tokens,last_error FROM ingestion_jobs WHERE version_id=v.id ORDER BY created_at DESC LIMIT 1) j) AS job
      FROM documents d JOIN policies p ON p.id=d.policy_id AND p.tenant_id=d.tenant_id JOIN document_versions v ON v.document_id=d.id AND v.tenant_id=d.tenant_id
      WHERE d.deleted_at IS NULL AND ($3::text IS NULL OR v.status=$3) ORDER BY v.created_at DESC,v.id LIMIT $1 OFFSET $2`,
            [query.limit, query.offset, query.status ?? null],
          )
        ).rows,
    );
    res.json({
      items,
      nextOffset:
        items.length === query.limit ? query.offset + query.limit : null,
    });
  });
  router.get("/documents/:id", async (req, res) => {
    const id = uuid.parse(req.params.id);
    const result = await withTenant(
      pool,
      user(res).tenantId,
      async (client) => {
        const document = (
          await client.query(
            "SELECT id,name,policy_id,document_type FROM documents WHERE id=$1 AND deleted_at IS NULL",
            [id],
          )
        ).rows[0];
        if (!document) throw new AppError("DOCUMENT_NOT_FOUND", 404);
        const versions = (
          await client.query(
            "SELECT id,version,status,effective_from::text,effective_to::text,supersedes_id,chunk_count,scan_status,failure_code FROM document_versions WHERE document_id=$1 ORDER BY version DESC",
            [id],
          )
        ).rows;
        return { ...document, versions };
      },
    );
    res.json(result);
  });
  router.get("/documents/:id/source/:versionId", async (req, res) => {
    const identity = user(res),
      id = uuid.parse(req.params.id),
      versionId = uuid.parse(req.params.versionId);
    const bytes = await withTenant(pool, identity.tenantId, async (client) => {
      const version = (
        await client.query(
          "SELECT s3_key,mime_type FROM document_versions WHERE id=$1 AND document_id=$2 AND scan_status='CLEAN' AND status='INDEXED' FOR SHARE",
          [versionId, id],
        )
      ).rows[0];
      if (!version) throw new AppError("DOCUMENT_NOT_FOUND", 404);
      const data = await storage.get(version.s3_key);
      await audit(
        client,
        identity,
        requestId(res),
        "document.downloaded",
        versionId,
      );
      return { data, mime: version.mime_type };
    });
    res.setHeader("Content-Type", bytes.mime);
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="policy-document"',
    );
    res.send(bytes.data);
  });
  router.get("/documents/:id/status", async (req, res) => {
    const documentId = uuid.parse(req.params.id);
    const versionId = uuid.optional().parse(req.query.versionId);
    const result = await withTenant(
      pool,
      user(res).tenantId,
      async (client) =>
        (
          await client.query(
            `SELECT id AS version_id,document_id,version,status,scan_status,failure_code,chunk_count,embedding_model,indexed_at FROM document_versions WHERE document_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY version DESC LIMIT 1`,
            [documentId, versionId ?? null],
          )
        ).rows[0],
    );
    if (!result) throw new AppError("DOCUMENT_NOT_FOUND", 404);
    res.json(result);
  });
  for (const route of ["/documents/:id/reindex", "/admin/documents/:id/retry"])
    router.post(route, async (req, res) => {
      const identity = user(res);
      requireAdmin(identity);
      const id = uuid.parse(req.params.id);
      const { versionId } = z
        .object({ versionId: uuid })
        .strict()
        .parse(req.body);
      const result = await withTenant(
        pool,
        identity.tenantId,
        async (client) => {
          const v = (
            await client.query(
              "SELECT * FROM document_versions WHERE id=$1 AND document_id=$2 FOR UPDATE",
              [versionId, id],
            )
          ).rows[0];
          if (!v) throw new AppError("DOCUMENT_NOT_FOUND", 404);
          if (["PENDING_UPLOAD", "ARCHIVED"].includes(v.status))
            throw new AppError("VERSION_NOT_RETRYABLE", 409);
          if (v.scan_status === "REJECTED")
            throw new AppError("QUARANTINED_DOCUMENT", 409);
          return queue(
            client,
            versionId,
            identity,
            res,
            uuid.parse(req.get("Idempotency-Key")),
          );
        },
      );
      res
        .status(202)
        .json({ versionId, jobId: result.id, status: result.status });
    });
  router.post("/documents/:id/archive", async (req, res) => {
    const identity = user(res);
    requireAdmin(identity);
    const id = uuid.parse(req.params.id);
    const { versionId } = z
      .object({ versionId: uuid })
      .strict()
      .parse(req.body);
    await withTenant(pool, identity.tenantId, async (client) => {
      // Lock jobs before versions, matching the worker publication order.
      await client.query(
        "SELECT id FROM ingestion_jobs WHERE version_id=$1 FOR UPDATE",
        [versionId],
      );
      const v = await client.query(
        "UPDATE document_versions SET status='ARCHIVED' WHERE id=$1 AND document_id=$2 RETURNING id",
        [versionId, id],
      );
      if (!v.rowCount) throw new AppError("DOCUMENT_NOT_FOUND", 404);
      await client.query(
        "UPDATE ingestion_jobs SET status='FAILED',last_error='VERSION_ARCHIVED',finished_at=now(),lease_until=NULL WHERE version_id=$1 AND status IN ('PENDING','RUNNING')",
        [versionId],
      );
      await audit(
        client,
        identity,
        requestId(res),
        "document.archived",
        versionId,
      );
    });
    res.status(204).end();
  });
  router.post("/search", async (req, res) => {
    const query = z
      .object({
        question: z.string().trim().min(1).max(4000),
        policyId: uuid,
        asOfDate: date.default(() => new Date().toISOString().slice(0, 10)),
        versionIds: z.array(uuid).min(1).max(20).optional(),
        mode: z.enum(["hybrid", "semantic", "keyword"]).optional(),
        rerank: z.boolean().optional(),
        candidateK: z.number().int().min(1).max(40).optional(),
        topK: z.number().int().min(1).max(10).default(5),
      })
      .strict()
      .parse(req.body);
    const result = await searchIndex(
      pool,
      embedder,
      vault,
      user(res).tenantId,
      query,
    );
    await withTenant(pool, user(res).tenantId, (client) =>
      audit(
        client,
        user(res),
        requestId(res),
        "policy.searched",
        query.policyId,
      ),
    );
    res.json(result);
  });
  if (services.chat) router.use(chatRouter(services.chat, auth));
  // Phase 2 compatibility for tests constructing an ingestion-only app.
  if (!services.chat)
    router.get("/conversations/:id", async (req, res) => {
      const identity = user(res),
        id = uuid.parse(req.params.id);
      const conversation = await withOwner(
        pool,
        identity,
        async (client) =>
          (
            await client.query(
              "SELECT id,title,created_at,expires_at FROM conversations WHERE id=$1 AND user_id=$2 AND expires_at>now()",
              [id, identity.id],
            )
          ).rows[0],
      );
      if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", 404);
      res.json(conversation);
    });
  return router;
}
