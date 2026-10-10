import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const base = "http://localhost:8080/api/v1";
const results = [];
async function login(email, password) {
  const r = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: {
      Origin: "http://localhost:8080",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}
const admin = await login(
  process.env.LOCAL_ADMIN_EMAIL,
  process.env.LOCAL_ADMIN_PASSWORD,
);
const advisor = await login(
  process.env.LOCAL_ADVISOR_EMAIL,
  process.env.LOCAL_ADVISOR_PASSWORD,
);
async function check(name, path, cookie, status, options = {}) {
  const r = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      Cookie: cookie,
      Origin: "http://localhost:8080",
      ...options.headers,
    },
  });
  assert.equal(r.status, status, name);
  const data = r.status === 204 ? null : await r.json();
  results.push({ name, status: r.status });
  return data;
}
await check(
  "Advisor cannot read audit logs",
  "/admin/audit-logs",
  advisor,
  403,
);
const audit = await check(
  "Admin can read tenant audit metadata",
  "/admin/audit-logs?limit=100",
  admin,
  200,
);
assert(audit.items.some((v) => v.action === "access.denied"));
assert(audit.items.some((v) => v.action === "audit.viewed"));
await check("Logout revokes session", "/auth/logout", admin, 204, {
  method: "POST",
});
const replay = await check(
  "Copied cookie rejected after logout",
  "/auth/me",
  admin,
  401,
);
assert.equal(replay.error.code, "TOKEN_REVOKED");
await check("Copied bearer rejected after logout", "/auth/me", "", 401, {
  headers: {
    Authorization: `Bearer ${admin.slice("advisor_session=".length)}`,
  },
});
await check("Other session still works", "/auth/me", advisor, 200);
await check("Advisor logout", "/auth/logout", advisor, 204, { method: "POST" });
writeFileSync(
  "docs/phase-5-demo.json",
  JSON.stringify(
    {
      validatedAt: new Date().toISOString(),
      environment: "local Docker Compose",
      checks: results,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Phase 5 security smoke passed: audit authorization and revoked cookie/bearer replay.",
);
