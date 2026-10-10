ALTER TABLE conversations ADD COLUMN policy_id uuid;
ALTER TABLE conversations ADD COLUMN as_of_date date;
ALTER TABLE conversations ADD COLUMN version_ids uuid[];
ALTER TABLE conversations ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE conversations ADD FOREIGN KEY(tenant_id,policy_id) REFERENCES policies(tenant_id,id);
CREATE INDEX conversations_owner ON conversations(tenant_id,user_id,updated_at DESC);
CREATE TABLE chat_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL, request_key uuid NOT NULL, request_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('RUNNING','COMPLETED','FAILED')),
  lease_until timestamptz NOT NULL, error_code text, response_encrypted text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,conversation_id,request_key),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id)
);
CREATE UNIQUE INDEX chat_one_running ON chat_runs(tenant_id,conversation_id) WHERE status='RUNNING';
ALTER TABLE chat_messages ADD COLUMN run_id uuid;
ALTER TABLE chat_messages ADD COLUMN content_encrypted boolean NOT NULL DEFAULT false;
ALTER TABLE chat_messages ADD FOREIGN KEY(tenant_id,run_id) REFERENCES chat_runs(tenant_id,id);
CREATE UNIQUE INDEX chat_run_role ON chat_messages(tenant_id,run_id,role) WHERE run_id IS NOT NULL;
ALTER TABLE chat_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_runs USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY conversation_owner ON conversations AS RESTRICTIVE USING (user_id=nullif(current_setting('app.user_id',true),'')::uuid AND expires_at>now()) WITH CHECK (user_id=nullif(current_setting('app.user_id',true),'')::uuid AND expires_at>now());
CREATE POLICY message_owner ON chat_messages AS RESTRICTIVE USING (EXISTS(SELECT 1 FROM conversations c WHERE c.id=conversation_id AND c.tenant_id=chat_messages.tenant_id)) WITH CHECK (EXISTS(SELECT 1 FROM conversations c WHERE c.id=conversation_id AND c.tenant_id=chat_messages.tenant_id));
CREATE POLICY run_owner ON chat_runs AS RESTRICTIVE USING (EXISTS(SELECT 1 FROM conversations c WHERE c.id=conversation_id AND c.tenant_id=chat_runs.tenant_id)) WITH CHECK (EXISTS(SELECT 1 FROM conversations c WHERE c.id=conversation_id AND c.tenant_id=chat_runs.tenant_id));
GRANT SELECT,INSERT,UPDATE ON chat_runs TO advisor_app;
REVOKE ALL ON conversations,chat_messages,retrieval_feedback,chat_runs FROM advisor_worker;
