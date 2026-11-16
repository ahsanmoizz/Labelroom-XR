-- Owner-only scheduler bridge. Actual credentials and activation are configured
-- separately after the reviewed Edge Function is deployed. No job starts here.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE TABLE labelroom_private.cleanup_dispatches (
  request_id bigint PRIMARY KEY,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON TABLE labelroom_private.cleanup_dispatches FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION labelroom_private.queue_project_cleanup()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE service_url text; maintenance_token text; request_id bigint;
BEGIN
  SELECT decrypted_secret INTO service_url FROM vault.decrypted_secrets
    WHERE name='labelxr_project_url';
  SELECT decrypted_secret INTO maintenance_token FROM vault.decrypted_secrets
    WHERE name='labelxr_cleanup_token';
  IF service_url IS NULL OR service_url !~ '^https://[a-z0-9]{20}\.supabase\.co$'
     OR maintenance_token IS NULL OR length(maintenance_token) NOT BETWEEN 32 AND 256
     OR maintenance_token !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Cleanup scheduler configuration is unavailable' USING ERRCODE='55000';
  END IF;
  SELECT net.http_post(
    url:=service_url||'/functions/v1/project-cleanup',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||maintenance_token),
    body:=jsonb_build_object('limit',10), timeout_milliseconds:=60000
  ) INTO request_id;
  IF request_id IS NULL THEN RAISE EXCEPTION 'Cleanup request was not queued'; END IF;
  INSERT INTO labelroom_private.cleanup_dispatches(request_id) VALUES(request_id);
  DELETE FROM labelroom_private.cleanup_dispatches WHERE queued_at<clock_timestamp()-interval '24 hours';
  RETURN request_id;
END $$;
REVOKE ALL ON FUNCTION labelroom_private.queue_project_cleanup() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
