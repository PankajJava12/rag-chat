REVOKE SELECT ON users FROM advisor_worker;
ALTER TABLE ingestion_jobs ADD COLUMN request_key uuid;
CREATE UNIQUE INDEX ingestion_request_key ON ingestion_jobs(tenant_id,version_id,request_key) WHERE request_key IS NOT NULL;
-- Chunk encryption starts in Phase 2. An existing Phase 1 corpus requires explicit encrypted reindexing.
-- Phase 1 creates no corpus; no source documents or archived bytes are automatically deleted here.
