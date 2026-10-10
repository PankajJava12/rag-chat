import { writeFileSync } from "node:fs";
const string = { type: "string" },
  uuid = { type: "string", format: "uuid" },
  date = { type: "string", format: "date" };
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const versionBody = object({ versionId: uuid });
const upload = object(
  {
    policyId: uuid,
    documentId: uuid,
    documentType: {
      enum: ["policy", "rider", "brochure", "terms"],
      default: "policy",
    },
    fileName: { type: "string", maxLength: 200 },
    mimeType: {
      enum: [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/csv",
      ],
    },
    sizeBytes: { type: "integer", minimum: 1, maximum: 26214400 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    effectiveFrom: date,
    effectiveTo: date,
    supersedesId: uuid,
  },
  ["policyId", "fileName", "mimeType", "sizeBytes", "sha256", "effectiveFrom"],
);
const health = object({
  status: { enum: ["ready", "degraded"] },
  service: string,
  checks: object({
    postgres: { enum: ["up", "down"] },
    redis: { enum: ["up", "down"] },
  }),
});
const paths = {};

function add(
  method,
  path,
  summary,
  {
    body,
    status = 200,
    publicRoute = false,
    idempotency = false,
    response = { type: "object" },
    parameters = [],
    binary = false,
  } = {},
) {
  const params = [
    ...Array.from(path.matchAll(/\{([^}]+)\}/g), (m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: uuid,
    })),
    ...parameters,
  ];
  if (idempotency)
    params.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: uuid,
    });
  const operation = {
    summary,
    security: publicRoute ? [] : [{ bearerAuth: [] }, { sessionCookie: [] }],
    parameters: params,
    responses: {
      [status]: {
        description: summary,
        ...(status === 204
          ? {}
          : { content: { "application/json": { schema: response } } }),
      },
      default: {
        description:
          "Safe error code. Common statuses: 400 validation, 401 authentication, 403 role/origin, 404 invisible resource, 409 state/version conflict, 413 size, 415 format, 429 rate limit, 503 dependency.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      },
    },
  };
  if (body)
    operation.requestBody = {
      required: true,
      content: binary
        ? Object.fromEntries(
            upload.properties.mimeType.enum.map((type) => [
              type,
              { schema: { type: "string", format: "binary" } },
            ]),
          )
        : { "application/json": { schema: body } },
    };
  paths[path] ??= {};
  paths[path][method] = operation;
}
add("get", "/health/live", "Process liveness", { publicRoute: true });
add("get", "/health/ready", "Real PostgreSQL migration and Redis readiness", {
  publicRoute: true,
  response: health,
});
paths["/health/ready"].get.responses["503"] = {
  description: "Dependency unavailable",
  content: { "application/json": { schema: health } },
};
add("get", "/api/v1/platform", "Implemented capability flags", {
  publicRoute: true,
});
add("get", "/api/v1/auth/config", "Authentication mode", { publicRoute: true });
add("post", "/api/v1/auth/login", "Local login; sets HttpOnly session cookie", {
  publicRoute: true,
  body: object({
    email: { type: "string", format: "email" },
    password: { type: "string", maxLength: 200 },
  }),
});
add("get", "/api/v1/auth/me", "Current server-resolved tenant and role");
add("post", "/api/v1/auth/logout", "Clear local session cookie", {
  status: 204,
});
add("get", "/api/v1/policies", "List tenant policies (maximum 100)");
add("post", "/api/v1/policies", "ADMIN: create a policy", {
  status: 201,
  body: object({
    name: { type: "string", minLength: 1, maxLength: 200 },
    provider: { type: "string", minLength: 1, maxLength: 200 },
  }),
});
add(
  "post",
  "/api/v1/documents/upload-url",
  "ADMIN: reserve immutable version; returns authenticated local PUT URL, not an S3 URL",
  { status: 201, idempotency: true, body: upload },
);
add(
  "put",
  "/api/v1/documents/uploads/{versionId}",
  "ADMIN/upload owner: validate and store encrypted bytes",
  {
    status: 204,
    binary: true,
    body: {},
    parameters: [
      {
        name: "Content-Length",
        in: "header",
        required: true,
        schema: { type: "integer", minimum: 1, maximum: 26214400 },
      },
    ],
  },
);
add(
  "post",
  "/api/v1/documents/complete-upload",
  "ADMIN/upload owner: atomically queue uploaded version; replay returns original job",
  { status: 202, body: versionBody },
);
add("get", "/api/v1/documents", "List tenant document versions", {
  parameters: [
    {
      name: "limit",
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    },
    {
      name: "offset",
      in: "query",
      schema: { type: "integer", minimum: 0, maximum: 10000, default: 0 },
    },
    {
      name: "status",
      in: "query",
      schema: { $ref: "#/components/schemas/DocumentStatus" },
    },
  ],
});
add("get", "/api/v1/documents/{id}", "Document details and immutable versions");
add(
  "get",
  "/api/v1/documents/{id}/status",
  "Specific or latest version processing status",
  { parameters: [{ name: "versionId", in: "query", schema: uuid }] },
);
add(
  "get",
  "/api/v1/documents/{id}/source/{versionId}",
  "Download authorized clean indexed source as attachment",
);
paths["/api/v1/documents/{id}/source/{versionId}"].get.responses[
  "200"
].content = {
  "application/octet-stream": { schema: { type: "string", format: "binary" } },
};
for (const path of [
  "/api/v1/documents/{id}/reindex",
  "/api/v1/admin/documents/{id}/retry",
])
  add(
    "post",
    path,
    "ADMIN: idempotent reindex/retry; quarantined and archived sources rejected",
    { status: 202, idempotency: true, body: versionBody },
  );
add(
  "post",
  "/api/v1/documents/{id}/archive",
  "ADMIN: archive version and cancel active jobs; retain source bytes",
  { status: 204, body: versionBody },
);
add(
  "post",
  "/api/v1/search",
  "Retrieve authorized effective-version evidence; ambiguous applicability returns 409, no generated answer",
  {
    body: object(
      {
        question: { type: "string", minLength: 1, maxLength: 4000 },
        policyId: uuid,
        asOfDate: date,
        versionIds: { type: "array", items: uuid, minItems: 1, maxItems: 20 },
        mode: {
          type: "string",
          enum: ["semantic", "hybrid", "keyword"],
          default: "hybrid",
        },
        rerank: { type: "boolean", default: true },
        candidateK: { type: "integer", minimum: 1, maximum: 40, default: 20 },
        topK: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      ["question", "policyId"],
    ),
  },
);
add(
  "get",
  "/api/v1/conversations/{id}",
  "Owner-only conversation and decrypted messages; expired/invisible records return 404",
);
add(
  "get",
  "/api/v1/conversations",
  "List up to 50 owned, unexpired conversations",
);
add(
  "post",
  "/api/v1/conversations",
  "Create a private chat with immutable policy/date scope and optional second comparison policy; comparison disallows explicit version IDs",
  {
    status: 201,
    body: object(
      {
        policyId: uuid,
        comparisonPolicyId: uuid,
        asOfDate: date,
        versionIds: { type: "array", items: uuid, minItems: 1, maxItems: 20 },
      },
      ["policyId", "asOfDate"],
    ),
  },
);
add(
  "post",
  "/api/v1/conversations/{id}/messages",
  "Retrieve evidence, generate checked quotations and persist one complete turn",
  {
    idempotency: true,
    body: object({
      question: { type: "string", minLength: 1, maxLength: 4000 },
    }),
    parameters: [
      {
        name: "Accept",
        in: "header",
        schema: {
          type: "string",
          enum: ["application/json", "text/event-stream"],
        },
        description:
          "Default JSON. SSE sends status/heartbeat, then validated delta and done, or a safe error event.",
      },
    ],
  },
);
paths["/api/v1/conversations/{id}/messages"].post.responses[200].content[
  "text/event-stream"
] = {
  schema: { type: "string" },
  example: 'event: status\ndata: {"stage":"retrieving"}\n\n',
};
const spec = {
  openapi: "3.1.0",
  info: {
    title: "AI Advisor Assistant — Local Ingestion and Chat API",
    version: "0.7.0",
    description:
      "Local Phase 5. Tokens are revocable at logout; audit reads are ADMIN-only. ADMIN/ADVISOR membership is server-resolved. Cookie writes require an allowed Origin. Policy data is tenant-scoped; chats enforce strict ownership and expiry. Generated answers contain validated source quotations. No AWS/LocalStack deployment.",
  },
  servers: [{ url: "http://localhost:3000" }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      sessionCookie: { type: "apiKey", in: "cookie", name: "advisor_session" },
    },
    schemas: {
      Error: object({
        error: object({ code: string, message: string, requestId: uuid }),
      }),
      DocumentStatus: {
        enum: [
          "PENDING_UPLOAD",
          "UPLOADED",
          "PROCESSING",
          "INDEXED",
          "FAILED",
          "ARCHIVED",
        ],
      },
      Upload: upload,
    },
  },
};
add(
  "get",
  "/admin/audit-logs",
  "ADMIN-only tenant audit metadata; access is audited",
  {
    parameters: [
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      {
        name: "before",
        in: "query",
        schema: { type: "string", format: "date-time" },
      },
    ],
  },
);
writeFileSync("docs/openapi.json", JSON.stringify(spec, null, 2) + "\n");
console.log("Generated docs/openapi.json");
