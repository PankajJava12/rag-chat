ALTER TABLE ingestion_jobs ADD COLUMN trace_parent text CHECK(trace_parent IS NULL OR trace_parent ~ '^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$');
ALTER TABLE ingestion_notifications ADD COLUMN trace_parent text CHECK(trace_parent IS NULL OR trace_parent ~ '^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$');
CREATE OR REPLACE FUNCTION enqueue_ingestion_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN INSERT INTO public.ingestion_notifications(job_id,tenant_id,trace_parent) VALUES(NEW.id,NEW.tenant_id,NEW.trace_parent); RETURN NEW; END $$;
REVOKE ALL ON FUNCTION enqueue_ingestion_notification() FROM PUBLIC;

CREATE FUNCTION ingestion_operational_metrics() RETURNS TABLE(pending bigint,failed bigint,notifications_pending bigint,oldest_pending_seconds double precision) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (SELECT count(*) FROM public.ingestion_jobs WHERE status='PENDING'),(SELECT count(*) FROM public.ingestion_jobs WHERE status='FAILED'),(SELECT count(*) FROM public.ingestion_notifications WHERE sent_at IS NULL),coalesce((SELECT extract(epoch FROM now()-min(created_at))::double precision FROM public.ingestion_jobs WHERE status='PENDING'),0);
$$;
REVOKE ALL ON FUNCTION ingestion_operational_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion_operational_metrics() TO advisor_worker;
