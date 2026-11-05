-- LABELXR-AI-CONTEXT-CONSENT-v1
BEGIN;
-- Change exactly one existing stale-budget marker. Preserve every other body/ACL/owner byte.
DO $guard$
DECLARE old_definition text;old_body text;new_body text;needle text:='Stale agent revision'' USING ERRCODE=''40001';
BEGIN
 SELECT pg_get_functiondef(p.oid),p.prosrc INTO old_definition,old_body FROM pg_proc p WHERE p.oid='public.reserve_ai_budget(uuid,uuid,uuid,integer,integer)'::regprocedure AND p.prosecdef AND p.prorettype='jsonb'::regtype;
 IF old_body IS NULL OR (length(old_body)-length(replace(old_body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Exact original stale budget signature required';END IF;
 new_body:=replace(old_body,needle,'Stale agent revision'' USING ERRCODE=''PT409');
 EXECUTE replace(old_definition,old_body,new_body);
 IF (SELECT prosrc FROM pg_proc WHERE oid='public.reserve_ai_budget(uuid,uuid,uuid,integer,integer)'::regprocedure)<>new_body THEN RAISE EXCEPTION 'Budget repair differs';END IF;
END $guard$;

CREATE FUNCTION public.ai_context(p_project uuid,p_source_hash text,p_revision integer,p_consent boolean DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
DECLARE p public.projects;labels jsonb;result jsonb;guest boolean;
BEGIN
 IF p_project IS NULL OR p_source_hash IS NULL OR p_source_hash!~'^[a-f0-9]{64}$' OR p_revision IS NULL OR p_revision NOT BETWEEN 0 AND 300 THEN RAISE EXCEPTION 'Invalid AI context' USING ERRCODE='22023';END IF;
 SELECT is_anonymous INTO guest FROM auth.users WHERE id=auth.uid();IF NOT FOUND THEN RAISE EXCEPTION 'Verified caller required' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM public.projects WHERE id=p_project AND owner_id=auth.uid() FOR UPDATE;
 IF NOT FOUND OR p.status<>'ready' OR (p.kind='demo') IS DISTINCT FROM guest OR (guest AND p.expires_at<=now()) THEN RAISE EXCEPTION 'Owned ready project required' USING ERRCODE='42501';END IF;
 IF p.source_hash<>p_source_hash OR p.current_revision<>p_revision THEN RAISE EXCEPTION 'Stale AI context' USING ERRCODE='PT409';END IF;
 IF p_consent IS NOT NULL THEN UPDATE public.projects SET ai_consent=p_consent WHERE id=p.id;p.ai_consent:=p_consent;END IF;
 SELECT label_doc INTO labels FROM public.label_versions WHERE project_id=p.id AND revision=p.current_revision;
 IF labels IS NULL OR jsonb_typeof(p.manifest->'frames')<>'array' OR jsonb_array_length(p.manifest->'frames') NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Stored AI context unavailable' USING ERRCODE='22023';END IF;
 SELECT jsonb_agg(jsonb_build_object('id',f->>'id','timestamp',f->'timestamp','pointCount',f->'pointCount','objects',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.key,'box',e.value#>'{object_data,cuboid,0,val}') ORDER BY e.key) FROM jsonb_each(COALESCE(labels#>ARRAY['openlabel','frames',f->>'id','objects'],'{}'::jsonb)) e),'[]'::jsonb)) ORDER BY ordinal) INTO result FROM jsonb_array_elements(p.manifest->'frames') WITH ORDINALITY AS a(f,ordinal);
 RETURN jsonb_build_object('projectId',p.id,'sourceBundleSha256',p.source_hash,'revision',p.current_revision,'consent',p.ai_consent,'frames',result);
END $$;
REVOKE ALL ON FUNCTION public.ai_context(uuid,text,integer,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ai_context(uuid,text,integer,boolean) TO authenticated;
COMMIT;
