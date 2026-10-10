import { randomUUID } from "node:crypto";
import { withTenant } from "../../database/src/tenant.js";
import type { Pool } from "pg";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { AppError } from "../../shared/src/errors.js";
import { hash, passwordHash, verifyPassword } from "./crypto.js";
export interface Identity {
  id: string;
  tenantId: string;
  role: "ADMIN" | "ADVISOR";
}
export interface AuthConfig {
  mode: "local" | "cognito";
  secret: string;
  userPoolId?: string;
  clientId?: string;
  environment: string;
}
export function createCognitoVerifier(userPoolId: string, clientId: string) {
  return CognitoJwtVerifier.create({
    userPoolId,
    clientId,
    tokenUse: "access",
  });
}
export class Authentication {
  private key: string;
  private cognito;
  private sessions = new WeakMap<
    Request,
    { digest: string; expiresAt: Date }
  >();
  private dummyHash = passwordHash("nonexistent-user-timing-padding");
  constructor(
    private pool: Pool,
    private config: AuthConfig,
  ) {
    if (config.mode === "local" && config.environment === "production")
      throw new Error("Local authentication is disabled in production");
    if (config.secret.length < 32)
      throw new Error("AUTH_SECRET must contain at least 32 characters");
    this.key = config.secret;
    if (config.mode === "cognito") {
      if (!config.userPoolId || !config.clientId)
        throw new Error("Cognito configuration required");
      this.cognito = createCognitoVerifier(config.userPoolId, config.clientId);
    }
  }
  async login(email: string, password: string) {
    if (this.config.mode !== "local")
      throw new AppError("COGNITO_LOGIN_REQUIRED", 400);
    const row = (
      await this.pool.query("SELECT * FROM lookup_local_login($1)", [
        email.toLowerCase(),
      ])
    ).rows[0];
    const valid = await verifyPassword(
      password,
      row?.password_hash ?? (await this.dummyHash),
    );
    if (!valid || !row || row.disabled)
      throw new AppError("INVALID_CREDENTIALS", 401);
    const token = jwt.sign({}, this.key, {
      algorithm: "HS256",
      subject: row.cognito_sub,
      jwtid: randomUUID(),
      issuer: "advisor-local",
      audience: "advisor-api",
      expiresIn: "1h",
    });
    return {
      token,
      user: { id: row.id, tenantId: row.tenant_id, role: row.role } as Identity,
    };
  }
  async authenticate(req: Request): Promise<Identity> {
    if (
      req.headers.authorization &&
      !/^Bearer (\S+)$/.test(req.headers.authorization)
    )
      throw new AppError("INVALID_TOKEN", 401);
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("advisor_session="))
      ?.slice(16);
    const token = bearer ?? cookie;
    if (!token) throw new AppError("AUTHENTICATION_REQUIRED", 401);
    let subject: string | undefined;
    let expires: number | undefined;
    try {
      const payload = this.cognito
        ? await this.cognito.verify(token)
        : (jwt.verify(token, this.key, {
            issuer: "advisor-local",
            audience: "advisor-api",
            algorithms: ["HS256"],
          }) as jwt.JwtPayload);
      subject = payload.sub;
      expires = payload.exp;
    } catch {
      throw new AppError("INVALID_TOKEN", 401);
    }
    if (!subject || !expires) throw new AppError("INVALID_TOKEN", 401);
    const digest = hash(token);
    if (
      (await this.pool.query("SELECT token_revoked($1) AS revoked", [digest]))
        .rows[0]?.revoked
    )
      throw new AppError("TOKEN_REVOKED", 401);
    this.sessions.set(req, { digest, expiresAt: new Date(expires * 1000) });
    const row = (
      await this.pool.query("SELECT * FROM lookup_identity($1)", [subject])
    ).rows[0];
    if (!row || row.disabled) throw new AppError("ACCESS_DENIED", 403);
    return { id: row.id, tenantId: row.tenant_id, role: row.role };
  }
  async logout(req: Request, identity: Identity, requestId: string) {
    const session = this.sessions.get(req);
    if (!session) throw new AppError("AUTHENTICATION_REQUIRED", 401);
    await withTenant(this.pool, identity.tenantId, async (client) => {
      await client.query(
        "INSERT INTO revoked_tokens(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [session.digest, identity.tenantId, identity.id, session.expiresAt],
      );
      await client.query(
        "INSERT INTO audit_logs(tenant_id,actor_id,action,request_id) VALUES($1,$2,'auth.logout',$3)",
        [identity.tenantId, identity.id, requestId],
      );
    });
  }
}
export function requireAdmin(identity: Identity) {
  if (identity.role !== "ADMIN") throw new AppError("ADMIN_REQUIRED", 403);
}
