-- Service-only, owner-bound demo reset and bounded expired/staging project cleanup.
BEGIN;

-- Keep original-upload metadata and retirement ordered on the same project row.
-- The lock lasts until the Storage metadata transaction ends. Cleanup takes
-- FOR UPDATE before removing objects, so it cannot finish around a late upload.
CREATE OR REPLACE FUNCTION labelroom_private.can_upload_original(object_name text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM public.projects p JOIN auth.users u ON u.id=p.owner_id
    WHERE p.owner_id=(SELECT auth.uid()) AND u.is_anonymous=false AND p.kind='private'
      AND p.status='staging' AND p.created_at>clock_timestamp()-interval '1 hour'
      AND object_name=p.storage_prefix||'/original.lrx.zip'
    FOR KEY SHARE OF p;
  RETURN FOUND;
END $$;

CREATE FUNCTION public.labelroom_demo_begin_reset(p_owner uuid,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.projects;
BEGIN
  PERFORM labelroom_private.lock_demo_guest(p_owner);
  IF p_id IS NULL THEN
    SELECT * INTO p FROM public.projects WHERE owner_id=p_owner AND kind='demo' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('id',NULL,'deleted',true); END IF;
    IF p.expires_at>clock_timestamp() AND p.status<>'deleting' THEN
      RAISE EXCEPTION 'Open the active demo before resetting it' USING ERRCODE='42501';
    END IF;
  ELSE
    SELECT * INTO p FROM public.projects WHERE id=p_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('id',p_id,'deleted',true); END IF;
  IF p.owner_id<>p_owner OR p.kind<>'demo' THEN RAISE EXCEPTION 'Owned demo required' USING ERRCODE='42501'; END IF;
  UPDATE public.projects SET status='deleting' WHERE id=p.id RETURNING * INTO p;
  RETURN labelroom_private.project_result(p);
END $$;

CREATE FUNCTION public.labelroom_demo_finish_reset(p_owner uuid,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.projects;
BEGIN
  PERFORM labelroom_private.lock_demo_guest(p_owner);
  SELECT * INTO p FROM public.projects WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('id',p_id,'deleted',true); END IF;
  IF p.owner_id<>p_owner OR p.kind<>'demo' THEN RAISE EXCEPTION 'Owned demo required' USING ERRCODE='42501'; END IF;
  IF p.status<>'deleting' OR EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='project-data'
    AND (name=p.storage_prefix OR left(name,length(p.storage_prefix)+1)=p.storage_prefix||'/')) THEN
    RAISE EXCEPTION 'Storage cleanup required' USING ERRCODE='55000';
  END IF;
  DELETE FROM public.projects WHERE id=p.id;
  RETURN jsonb_build_object('id',p_id,'deleted',true);
END $$;

CREATE FUNCTION public.labelroom_cleanup_candidates(p_limit integer DEFAULT 10)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'Bounded cleanup limit required' USING ERRCODE='22023'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'owner_id',owner_id,'storage_prefix',storage_prefix))
    FROM (SELECT id,owner_id,storage_prefix FROM public.projects
      WHERE (kind='demo' AND expires_at<=clock_timestamp())
        OR (status='staging' AND created_at<=clock_timestamp()-interval '1 hour')
        OR (status='deleting' AND updated_at<=clock_timestamp()-interval '5 minutes')
      ORDER BY created_at,id LIMIT p_limit) eligible),'[]'::jsonb);
END $$;

CREATE FUNCTION public.labelroom_cleanup_begin(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.projects;
BEGIN
  SELECT * INTO p FROM public.projects WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('id',p_id,'deleted',true); END IF;
  -- Recheck under the lock: a staging project may have become a ready private project.
  IF NOT ((p.kind='demo' AND p.expires_at<=clock_timestamp())
    OR (p.status='staging' AND p.created_at<=clock_timestamp()-interval '1 hour')
    OR (p.status='deleting' AND p.updated_at<=clock_timestamp()-interval '5 minutes')) THEN
    RAISE EXCEPTION 'Project is not eligible for cleanup' USING ERRCODE='42501';
  END IF;
  UPDATE public.projects SET status='deleting' WHERE id=p.id;
  RETURN jsonb_build_object('id',p.id,'owner_id',p.owner_id,'storage_prefix',p.storage_prefix,'status','deleting');
END $$;

CREATE FUNCTION public.labelroom_cleanup_finish(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.projects;
BEGIN
  SELECT * INTO p FROM public.projects WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('id',p_id,'deleted',true); END IF;
  IF p.status<>'deleting' OR EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='project-data'
    AND (name=p.storage_prefix OR left(name,length(p.storage_prefix)+1)=p.storage_prefix||'/')) THEN
    RAISE EXCEPTION 'Storage cleanup required' USING ERRCODE='55000';
  END IF;
  DELETE FROM public.projects WHERE id=p.id;
  RETURN jsonb_build_object('id',p_id,'deleted',true);
END $$;

REVOKE ALL ON FUNCTION public.labelroom_demo_begin_reset(uuid,uuid),public.labelroom_demo_finish_reset(uuid,uuid),
 public.labelroom_cleanup_candidates(integer),public.labelroom_cleanup_begin(uuid),public.labelroom_cleanup_finish(uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.labelroom_demo_begin_reset(uuid,uuid),public.labelroom_demo_finish_reset(uuid,uuid),
 public.labelroom_cleanup_candidates(integer),public.labelroom_cleanup_begin(uuid),public.labelroom_cleanup_finish(uuid)
 TO service_role;
COMMIT;
