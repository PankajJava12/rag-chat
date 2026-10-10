CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  cognito_sub text NOT NULL UNIQUE, role text NOT NULL CHECK (role IN ('admin','advisor')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL, provider text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  policy_id uuid NOT NULL, name text NOT NULL, document_type text NOT NULL,
  deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,policy_id) REFERENCES policies(tenant_id,id)
);
CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, document_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0), s3_key text NOT NULL UNIQUE, s3_version_id text,
  file_name text NOT NULL, mime_type text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes > 0),
  content_hash varchar(64), uploaded_by uuid NOT NULL, effective_from date, effective_to date,
  status text NOT NULL DEFAULT 'PENDING_UPLOAD' CHECK(status IN ('PENDING_UPLOAD','UPLOADED','PROCESSING','COMPLETED','FAILED')),
  active_generation_id uuid, failure_code text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,document_id,version),
  FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id),
  FOREIGN KEY(tenant_id,uploaded_by) REFERENCES users(tenant_id,id),
  CHECK(effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
CREATE TABLE ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, version_id uuid NOT NULL,
  generation_id uuid NOT NULL, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  attempts integer NOT NULL DEFAULT 0, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,version_id,generation_id), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,version_id) REFERENCES document_versions(tenant_id,id)
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_type text NOT NULL, payload jsonb NOT NULL, published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox_events(created_at) WHERE published_at IS NULL;
CREATE TABLE document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, version_id uuid NOT NULL,
  generation_id uuid NOT NULL, chunk_index integer NOT NULL CHECK(chunk_index >= 0),
  content text NOT NULL, content_hash varchar(64) NOT NULL, embedding vector(1536) NOT NULL,
  embedding_model text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english',content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,version_id,generation_id,chunk_index),
  FOREIGN KEY(tenant_id,version_id) REFERENCES document_versions(tenant_id,id)
);
CREATE INDEX chunks_scope ON document_chunks(tenant_id,version_id,generation_id);
CREATE INDEX chunks_keywords ON document_chunks USING gin(search_vector);
CREATE INDEX chunks_vector ON document_chunks USING hnsw(embedding vector_cosine_ops);
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  title text NOT NULL DEFAULT 'New conversation', summary text, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, conversation_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]', insufficient_evidence boolean,
  input_tokens integer CHECK(input_tokens >= 0), output_tokens integer CHECK(output_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id)
);
CREATE INDEX messages_history ON chat_messages(tenant_id,conversation_id,created_at,id);
CREATE TABLE retrieval_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, message_id uuid NOT NULL,
  user_id uuid NOT NULL, rating integer NOT NULL CHECK(rating IN (-1,1)), comment text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,message_id,user_id),
  FOREIGN KEY(tenant_id,message_id) REFERENCES chat_messages(tenant_id,id),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid, action text NOT NULL, resource_id uuid, request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['tenants','users','policies','documents','document_versions','ingestion_jobs','outbox_events','document_chunks','conversations','chat_messages','retrieval_feedback','audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (%I = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (%I = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',name,CASE WHEN name='tenants' THEN 'id' ELSE 'tenant_id' END,CASE WHEN name='tenants' THEN 'id' ELSE 'tenant_id' END);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO advisor_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO advisor_app;
REVOKE ALL ON schema_migrations FROM advisor_app;
GRANT SELECT ON schema_migrations TO advisor_app;
REVOKE UPDATE,DELETE ON audit_logs FROM advisor_app;
