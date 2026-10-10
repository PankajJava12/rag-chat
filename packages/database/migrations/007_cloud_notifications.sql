CREATE TABLE ingestion_notifications (
 job_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,
 attempts integer NOT NULL DEFAULT 0,lease_token uuid,lease_until timestamptz,
 available_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,
 FOREIGN KEY(tenant_id,job_id) REFERENCES ingestion_jobs(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE ingestion_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ingestion_notifications USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION enqueue_ingestion_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN INSERT INTO public.ingestion_notifications(job_id,tenant_id) VALUES(NEW.id,NEW.tenant_id); RETURN NEW; END $$;
REVOKE ALL ON FUNCTION enqueue_ingestion_notification() FROM PUBLIC;
CREATE TRIGGER job_notification AFTER INSERT ON ingestion_jobs FOR EACH ROW EXECUTE FUNCTION enqueue_ingestion_notification();
CREATE FUNCTION claim_ingestion_notification() RETURNS SETOF ingestion_notifications LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected uuid;
BEGIN
 SELECT job_id INTO selected FROM public.ingestion_notifications WHERE sent_at IS NULL AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF selected IS NULL THEN RETURN; END IF;
 RETURN QUERY UPDATE public.ingestion_notifications SET attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '30 seconds' WHERE job_id=selected RETURNING *;
END $$;
CREATE FUNCTION finish_ingestion_notification(job uuid,token uuid,success boolean) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 UPDATE public.ingestion_notifications SET sent_at=CASE WHEN success THEN now() ELSE NULL END,lease_until=NULL,lease_token=NULL,available_at=now()+interval '30 seconds' WHERE job_id=job AND lease_token=token;
$$;
REVOKE ALL ON FUNCTION claim_ingestion_notification(),finish_ingestion_notification(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_ingestion_notification(),finish_ingestion_notification(uuid,uuid,boolean) TO advisor_worker;
CREATE INDEX notification_pending ON ingestion_notifications(available_at) WHERE sent_at IS NULL;
