ALTER TABLE document_chunks ADD COLUMN keyword_vector tsvector NOT NULL DEFAULT ''::tsvector;
ALTER TABLE document_chunks ADD COLUMN keyword_profile text;
CREATE INDEX chunks_keyword_blind ON document_chunks USING gin(keyword_vector);
ALTER TABLE conversations ADD COLUMN comparison_policy_id uuid;
ALTER TABLE conversations ADD FOREIGN KEY(tenant_id,comparison_policy_id) REFERENCES policies(tenant_id,id);
ALTER TABLE conversations ADD CONSTRAINT comparison_distinct CHECK(comparison_policy_id IS NULL OR comparison_policy_id<>policy_id);
ALTER TABLE conversations ADD CONSTRAINT comparison_versions CHECK(comparison_policy_id IS NULL OR version_ids IS NULL);
ALTER TABLE conversations ADD COLUMN memory_encrypted text;
ALTER TABLE conversations ADD COLUMN memory_revision integer NOT NULL DEFAULT 0;
