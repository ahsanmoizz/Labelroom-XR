-- LABELXR-DEMO-PROVISION-v1
BEGIN;

CREATE FUNCTION labelroom_private.lock_demo_guest(p_owner uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE guest boolean;
BEGIN
  SELECT is_anonymous INTO guest FROM auth.users WHERE id=p_owner FOR UPDATE;
  IF guest IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Guest required' USING ERRCODE='42501';
  END IF;
END $$;

CREATE FUNCTION public.labelroom_demo_reserve(p_owner uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  project public.projects;
  project_id uuid;
  seed_hash CONSTANT text := 'a23c36b9a243e7d8d9bace94c44caf40e8467c5dd1d8f10ed9e7f60834addc9b';
  seed_bytes CONSTANT bigint := 11404047;
BEGIN
  PERFORM labelroom_private.lock_demo_guest(p_owner);
  SELECT * INTO project FROM public.projects WHERE owner_id=p_owner AND kind='demo' FOR UPDATE;
  IF FOUND THEN
    IF project.expires_at<=clock_timestamp() OR project.status='deleting'
       OR project.source_hash IS DISTINCT FROM seed_hash OR project.source_bytes IS DISTINCT FROM seed_bytes THEN
      RAISE EXCEPTION 'Demo changed or expired' USING ERRCODE='40001';
    END IF;
  ELSE
    project_id := gen_random_uuid();
    INSERT INTO public.projects(id,owner_id,kind,source_hash,source_bytes,storage_prefix)
      VALUES(project_id,p_owner,'demo',seed_hash,seed_bytes,p_owner::text||'/'||project_id::text)
      RETURNING * INTO project;
  END IF;
  RETURN labelroom_private.project_result(project);
END $$;

CREATE FUNCTION public.labelroom_demo_finalize(p_owner uuid,p_id uuid,p_manifest jsonb,p_labels jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE project public.projects;
BEGIN
  PERFORM labelroom_private.lock_demo_guest(p_owner);
  SELECT * INTO project FROM public.projects
    WHERE id=p_id AND owner_id=p_owner AND kind='demo' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Demo unavailable' USING ERRCODE='42501';
  END IF;
  IF project.expires_at<=clock_timestamp() OR project.status='deleting'
     OR project.source_hash IS DISTINCT FROM 'a23c36b9a243e7d8d9bace94c44caf40e8467c5dd1d8f10ed9e7f60834addc9b'
     OR project.source_bytes IS DISTINCT FROM 11404047 THEN
    RAISE EXCEPTION 'Demo changed or expired' USING ERRCODE='40001';
  END IF;
  IF jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR jsonb_typeof(p_labels) IS DISTINCT FROM 'object'
     OR octet_length(p_manifest::text)>262144 OR octet_length(p_labels::text)>4194304 THEN
    RAISE EXCEPTION 'Invalid demo source' USING ERRCODE='22023';
  END IF;
  IF project.status='ready' THEN
    IF project.manifest IS DISTINCT FROM p_manifest OR project.source_label_doc IS DISTINCT FROM p_labels THEN
      RAISE EXCEPTION 'Immutable demo source' USING ERRCODE='40001';
    END IF;
    RETURN labelroom_private.project_result(project);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='project-data'
                AND name=project.storage_prefix||'/original.lrx.zip') THEN
    RAISE EXCEPTION 'Missing demo original' USING ERRCODE='55000';
  END IF;
  UPDATE public.projects SET manifest=p_manifest,source_label_doc=p_labels WHERE id=project.id;
  INSERT INTO public.label_versions(project_id,revision,label_doc) VALUES(project.id,0,p_labels);
  UPDATE public.projects SET status='ready' WHERE id=project.id RETURNING * INTO project;
  RETURN labelroom_private.project_result(project);
END $$;

REVOKE ALL ON FUNCTION labelroom_private.lock_demo_guest(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.labelroom_demo_reserve(uuid),public.labelroom_demo_finalize(uuid,uuid,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.labelroom_demo_reserve(uuid),public.labelroom_demo_finalize(uuid,uuid,jsonb,jsonb)
  TO service_role;
COMMIT;
