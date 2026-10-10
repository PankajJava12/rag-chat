-- Account provisioning and tenant configuration are migration/operator responsibilities.
-- Runtime cannot read password hashes or escalate roles through ordinary table grants.
REVOKE ALL ON users FROM advisor_app;
REVOKE INSERT,UPDATE,DELETE ON tenants FROM advisor_app;

CREATE TABLE revoked_tokens (
  token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE revoked_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE revoked_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON revoked_tokens
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT INSERT ON revoked_tokens TO advisor_app;
CREATE FUNCTION token_revoked(digest text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.revoked_tokens WHERE token_hash=digest AND expires_at>now());
$$;
REVOKE ALL ON FUNCTION token_revoked(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION token_revoked(text) TO advisor_app;
CREATE INDEX revoked_token_expiry ON revoked_tokens(expires_at);
-- Fixed-function lookup is required before a tenant has been established.
-- Explicit pg_temp at the end protects SECURITY DEFINER functions from temp shadowing.
ALTER FUNCTION lookup_identity(text) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION lookup_local_login(text) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION claim_ingestion_job() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION token_revoked(text) SET search_path=pg_catalog,public,pg_temp;
