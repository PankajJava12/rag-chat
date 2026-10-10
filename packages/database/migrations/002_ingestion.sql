-- Additive upgrade: never rewrite an applied migration.
ALTER TABLE tenants ADD COLUMN document_retention_days integer CHECK(document_retention_days > 0);
ALTER TABLE tenants ADD COLUMN conversation_retention_days integer NOT NULL DEFAULT 90 CHECK(conversation_retention_days > 0);
ALTER TABLE tenants ADD COLUMN retention_approved boolean NOT NULL DEFAULT false;
ALTER TABLE users DROP CONSTRAINT users_role_check;
UPDATE users SET role=upper(role);
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('ADMIN','ADVISOR'));
ALTER TABLE users ADD COLUMN email text UNIQUE;
ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ADD COLUMN disabled boolean NOT NULL DEFAULT false;
ALTER TABLE document_versions DROP CONSTRAINT document_versions_status_check;
UPDATE document_versions SET status='INDEXED' WHERE status='COMPLETED';
ALTER TABLE document_versions ADD CONSTRAINT document_versions_status_check CHECK(status IN ('PENDING_UPLOAD','UPLOADED','PROCESSING','INDEXED','FAILED','ARCHIVED'));
ALTER TABLE document_versions ADD COLUMN supersedes_id uuid;
ALTER TABLE document_versions ADD CONSTRAINT supersedes_scope FOREIGN KEY(tenant_id,supersedes_id) REFERENCES document_versions(tenant_id,id);
ALTER TABLE document_versions ADD COLUMN upload_expires_at timestamptz NOT NULL DEFAULT (now()+interval '15 minutes');
ALTER TABLE document_versions ADD COLUMN uploaded_at timestamptz;
ALTER TABLE document_versions ADD COLUMN indexed_at timestamptz;
ALTER TABLE document_versions ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE document_versions ADD COLUMN scan_status text NOT NULL DEFAULT 'PENDING' CHECK(scan_status IN ('PENDING','CLEAN','REJECTED'));
ALTER TABLE document_versions ADD COLUMN chunk_count integer NOT NULL DEFAULT 0;
ALTER TABLE document_versions ADD COLUMN embedding_model text;
ALTER TABLE document_versions ADD COLUMN embedding_dimensions integer;
ALTER TABLE document_versions ADD COLUMN parser_version text;
ALTER TABLE document_versions ADD COLUMN request_id uuid;
ALTER TABLE document_versions ADD COLUMN upload_idempotency_key uuid;
ALTER TABLE document_versions ADD COLUMN upload_request_hash text;
CREATE UNIQUE INDEX version_upload_idempotency ON document_versions(tenant_id,uploaded_by,upload_idempotency_key);
ALTER TABLE ingestion_jobs ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE ingestion_jobs ADD COLUMN lease_token uuid;
ALTER TABLE ingestion_jobs ADD COLUMN last_error text;
ALTER TABLE ingestion_jobs ADD COLUMN request_id uuid;
ALTER TABLE ingestion_jobs ADD COLUMN input_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE ingestion_jobs ADD COLUMN processed_chunks integer NOT NULL DEFAULT 0;
ALTER TABLE ingestion_jobs ADD COLUMN finished_at timestamptz;
CREATE UNIQUE INDEX one_active_job ON ingestion_jobs(tenant_id,version_id) WHERE status IN ('PENDING','RUNNING');
CREATE INDEX ready_jobs ON ingestion_jobs(available_at,created_at) WHERE status IN ('PENDING','RUNNING');
-- Mixed models are stored with explicit dimensions and searched only within a matching profile.
DROP INDEX chunks_vector;
ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector;
ALTER TABLE document_chunks ADD COLUMN embedding_dimensions integer NOT NULL DEFAULT 1536;
ALTER TABLE document_chunks ADD CONSTRAINT chunk_dimensions CHECK(vector_dims(embedding)=embedding_dimensions AND embedding_dimensions IN (768,1536));
CREATE INDEX chunks_vector_768 ON document_chunks USING hnsw((embedding::vector(768)) vector_cosine_ops) WHERE embedding_dimensions=768;
CREATE INDEX chunks_vector_1536 ON document_chunks USING hnsw((embedding::vector(1536)) vector_cosine_ops) WHERE embedding_dimensions=1536;
-- Policy text is encrypted by the application; do not index ciphertext as searchable words.
DROP INDEX chunks_keywords;
ALTER TABLE document_chunks DROP COLUMN search_vector;
CREATE TABLE embedding_cache (
  tenant_id uuid NOT NULL REFERENCES tenants(id), content_hash text NOT NULL,
  model text NOT NULL, dimensions integer NOT NULL, embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,content_hash,model,dimensions),
  CHECK(vector_dims(embedding)=dimensions AND dimensions IN (768,1536))
);
ALTER TABLE embedding_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON embedding_cache USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON embedding_cache TO advisor_app;

CREATE FUNCTION enforce_version_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM document_versions v WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.supersedes_id AND v.document_id=NEW.document_id AND v.version < NEW.version) THEN
      RAISE EXCEPTION 'Invalid supersession' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (NEW.tenant_id,NEW.document_id,NEW.version,NEW.s3_key,NEW.file_name,NEW.mime_type,NEW.size_bytes,NEW.content_hash,NEW.uploaded_by,NEW.effective_from,NEW.effective_to,NEW.supersedes_id)
      IS DISTINCT FROM (OLD.tenant_id,OLD.document_id,OLD.version,OLD.s3_key,OLD.file_name,OLD.mime_type,OLD.size_bytes,OLD.content_hash,OLD.uploaded_by,OLD.effective_from,OLD.effective_to,OLD.supersedes_id) THEN
      RAISE EXCEPTION 'Document versions are immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.status<>OLD.status AND NOT (
      (OLD.status='PENDING_UPLOAD' AND NEW.status IN ('UPLOADED','ARCHIVED')) OR
      (OLD.status='UPLOADED' AND NEW.status IN ('PROCESSING','FAILED','ARCHIVED')) OR
      (OLD.status='PROCESSING' AND NEW.status IN ('INDEXED','FAILED','UPLOADED','ARCHIVED')) OR
      (OLD.status='INDEXED' AND NEW.status IN ('PROCESSING','UPLOADED','ARCHIVED')) OR
      (OLD.status='FAILED' AND NEW.status IN ('UPLOADED','ARCHIVED'))
    ) THEN RAISE EXCEPTION 'Invalid lifecycle transition' USING ERRCODE='23514'; END IF;
  END IF;
  NEW.updated_at=now();
  RETURN NEW;
END $$;
CREATE TRIGGER version_lifecycle BEFORE INSERT OR UPDATE ON document_versions FOR EACH ROW EXECUTE FUNCTION enforce_version_lifecycle();

-- Narrow SECURITY DEFINER entry points: no arbitrary SQL, fixed search path, revoked PUBLIC access.
-- Bootstrap/migration role owns these functions; the API itself never receives its credentials.
CREATE FUNCTION lookup_identity(subject text) RETURNS TABLE(id uuid,tenant_id uuid,role text,disabled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT u.id,u.tenant_id,u.role,u.disabled FROM public.users u WHERE u.cognito_sub=subject;
$$;
CREATE FUNCTION lookup_local_login(login_email text) RETURNS TABLE(id uuid,tenant_id uuid,role text,cognito_sub text,password_hash text,disabled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT u.id,u.tenant_id,u.role,u.cognito_sub,u.password_hash,u.disabled FROM public.users u WHERE u.email=lower(login_email) AND u.cognito_sub LIKE 'local:%';
$$;
REVOKE ALL ON FUNCTION lookup_identity(text),lookup_local_login(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_identity(text),lookup_local_login(text) TO advisor_app;

CREATE FUNCTION claim_ingestion_job() RETURNS SETOF ingestion_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE selected public.ingestion_jobs%ROWTYPE;
BEGIN
  -- Exhausted crashed jobs enter the durable failed queue instead of looping forever.
  UPDATE public.document_versions v SET status='FAILED',failure_code='RETRY_EXHAUSTED'
    FROM public.ingestion_jobs j WHERE j.version_id=v.id AND j.tenant_id=v.tenant_id AND j.status='RUNNING' AND j.lease_until<now() AND j.attempts>=3 AND v.status<>'ARCHIVED';
  UPDATE public.ingestion_jobs SET status='FAILED',last_error='RETRY_EXHAUSTED',finished_at=now()
    WHERE status='RUNNING' AND lease_until<now() AND attempts>=3;
  SELECT j.* INTO selected FROM public.ingestion_jobs j JOIN public.document_versions v ON v.id=j.version_id AND v.tenant_id=j.tenant_id
    WHERE ((j.status='PENDING' AND j.available_at<=now()) OR (j.status='RUNNING' AND j.lease_until<now()))
    AND j.attempts<3 AND v.status<>'ARCHIVED' ORDER BY j.available_at,j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1;
  IF selected.id IS NULL THEN RETURN; END IF;
  RETURN QUERY UPDATE public.ingestion_jobs SET status='RUNNING',attempts=attempts+1,lease_until=now()+interval '90 seconds',lease_token=gen_random_uuid()
    WHERE id=selected.id RETURNING *;
END $$;
REVOKE ALL ON FUNCTION claim_ingestion_job() FROM PUBLIC;
-- Worker is a separately provisioned NOBYPASSRLS role.
GRANT USAGE ON SCHEMA public TO advisor_worker;
GRANT SELECT ON schema_migrations,tenants,users,policies,documents TO advisor_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON document_versions,document_chunks,embedding_cache,ingestion_jobs TO advisor_worker;
GRANT INSERT ON audit_logs TO advisor_worker;
GRANT EXECUTE ON FUNCTION claim_ingestion_job() TO advisor_worker;
-- The worker cannot invoke credential lookup functions. The API cannot claim background jobs.
REVOKE DELETE ON documents,document_versions FROM advisor_app;
