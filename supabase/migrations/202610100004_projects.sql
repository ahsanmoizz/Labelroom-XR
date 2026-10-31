-- LABELXR-PROJECT-LIFECYCLE-v1
-- Service-only RPCs: the Edge handler supplies a remotely verified member UID.
BEGIN;
CREATE FUNCTION labelroom_private.project_member(owner uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE guest boolean;
BEGIN
 SELECT is_anonymous INTO guest FROM auth.users WHERE id=owner FOR UPDATE;
 IF guest IS DISTINCT FROM false THEN RAISE EXCEPTION 'Member required' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION labelroom_private.project_result(p public.projects) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',p.id,'owner_id',p.owner_id,'status',p.status,'source_hash',p.source_hash,'source_bytes',p.source_bytes,'storage_prefix',p.storage_prefix,'current_revision',p.current_revision)
$$;
CREATE FUNCTION public.labelroom_project_reserve(p_owner uuid,p_id uuid,p_hash text,p_bytes bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.projects; slot smallint;
BEGIN
 PERFORM labelroom_private.project_member(p_owner);
 IF p_id IS NULL OR p_hash IS NULL OR p_hash!~'^[0-9a-f]{64}$' OR p_bytes IS NULL OR p_bytes NOT BETWEEN 1 AND 26214400 THEN RAISE EXCEPTION 'Invalid source' USING ERRCODE='22023'; END IF;
 SELECT * INTO p FROM public.projects WHERE id=p_id FOR UPDATE;
 IF FOUND THEN
  IF p.owner_id<>p_owner OR p.kind<>'private' THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='42501'; END IF;
  IF p.source_hash IS DISTINCT FROM p_hash OR p.source_bytes IS DISTINCT FROM p_bytes OR p.status='deleting' OR (p.status='staging' AND p.created_at<=now()-interval '1 hour') THEN RAISE EXCEPTION 'Changed or expired' USING ERRCODE='40001'; END IF;
  RETURN labelroom_private.project_result(p);
 END IF;
 SELECT s::smallint INTO slot FROM generate_series(1,3) s WHERE NOT EXISTS(SELECT 1 FROM public.projects x WHERE x.owner_id=p_owner AND x.kind='private' AND x.status IN ('staging','ready') AND x.quota_slot=s) ORDER BY s LIMIT 1;
 IF slot IS NULL THEN RAISE EXCEPTION 'Quota reached' USING ERRCODE='P0001'; END IF;
 INSERT INTO public.projects(id,owner_id,kind,quota_slot,source_hash,source_bytes,storage_prefix) VALUES(p_id,p_owner,'private',slot,p_hash,p_bytes,p_owner::text||'/'||p_id::text) RETURNING * INTO p;
 RETURN labelroom_private.project_result(p);
END $$;
CREATE FUNCTION public.labelroom_project_lookup(p_owner uuid,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.projects;
BEGIN
 PERFORM labelroom_private.project_member(p_owner);
 SELECT * INTO p FROM public.projects WHERE id=p_id AND owner_id=p_owner AND kind='private';
 IF NOT FOUND THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='42501'; END IF;
 RETURN labelroom_private.project_result(p);
END $$;
CREATE FUNCTION public.labelroom_project_finalize(p_owner uuid,p_id uuid,p_hash text,p_bytes bigint,p_manifest jsonb,p_labels jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.projects;
BEGIN
 PERFORM labelroom_private.project_member(p_owner);
 SELECT * INTO p FROM public.projects WHERE id=p_id AND owner_id=p_owner AND kind='private' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='42501'; END IF;
 IF p_hash IS DISTINCT FROM p.source_hash OR p_bytes IS DISTINCT FROM p.source_bytes OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR jsonb_typeof(p_labels) IS DISTINCT FROM 'object' OR octet_length(p_manifest::text)>262144 OR octet_length(p_labels::text)>4194304 THEN RAISE EXCEPTION 'Source differs' USING ERRCODE='22023'; END IF;
 IF p.status='ready' THEN
  IF p.manifest IS DISTINCT FROM p_manifest OR p.source_label_doc IS DISTINCT FROM p_labels THEN RAISE EXCEPTION 'Immutable original' USING ERRCODE='40001'; END IF;
  RETURN labelroom_private.project_result(p);
 END IF;
 IF p.status<>'staging' OR p.created_at<=now()-interval '1 hour' THEN RAISE EXCEPTION 'Changed or expired' USING ERRCODE='40001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='project-data' AND name=p.storage_prefix||'/original.lrx.zip') THEN RAISE EXCEPTION 'Missing original' USING ERRCODE='55000'; END IF;
 UPDATE public.projects SET manifest=p_manifest,source_label_doc=p_labels WHERE id=p.id;
 INSERT INTO public.label_versions(project_id,revision,label_doc) VALUES(p.id,0,p_labels);
 UPDATE public.projects SET status='ready' WHERE id=p.id RETURNING * INTO p;
 RETURN labelroom_private.project_result(p);
END $$;
CREATE FUNCTION public.labelroom_project_begin_delete(p_owner uuid,p_id uuid,p_staging_only boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.projects;
BEGIN
 PERFORM labelroom_private.project_member(p_owner);
 IF p_id IS NULL OR p_staging_only IS NULL THEN RAISE EXCEPTION 'Invalid delete' USING ERRCODE='22023'; END IF;
 SELECT * INTO p FROM public.projects WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('id',p_id,'deleted',true); END IF;
 IF p.owner_id<>p_owner OR p.kind<>'private' THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='42501'; END IF;
 IF p_staging_only AND p.status='ready' THEN RETURN labelroom_private.project_result(p); END IF;
 UPDATE public.projects SET status='deleting' WHERE id=p.id RETURNING * INTO p;
 RETURN labelroom_private.project_result(p);
END $$;
CREATE FUNCTION public.labelroom_project_finish_delete(p_owner uuid,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.projects;
BEGIN
 PERFORM labelroom_private.project_member(p_owner);
 SELECT * INTO p FROM public.projects WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('id',p_id,'deleted',true); END IF;
 IF p.owner_id<>p_owner OR p.kind<>'private' THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='42501'; END IF;
 IF p.status<>'deleting' OR EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='project-data' AND (name=p.storage_prefix OR left(name,length(p.storage_prefix)+1)=p.storage_prefix||'/')) THEN RAISE EXCEPTION 'Storage cleanup required' USING ERRCODE='55000'; END IF;
 DELETE FROM public.projects WHERE id=p.id;
 RETURN jsonb_build_object('id',p_id,'deleted',true);
END $$;
REVOKE ALL ON FUNCTION labelroom_private.project_member(uuid),labelroom_private.project_result(public.projects) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.labelroom_project_reserve(uuid,uuid,text,bigint),public.labelroom_project_lookup(uuid,uuid),public.labelroom_project_finalize(uuid,uuid,text,bigint,jsonb,jsonb),public.labelroom_project_begin_delete(uuid,uuid,boolean),public.labelroom_project_finish_delete(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.labelroom_project_reserve(uuid,uuid,text,bigint),public.labelroom_project_lookup(uuid,uuid),public.labelroom_project_finalize(uuid,uuid,text,bigint,jsonb,jsonb),public.labelroom_project_begin_delete(uuid,uuid,boolean),public.labelroom_project_finish_delete(uuid,uuid) TO service_role;
COMMIT;
