-- LABELXR-CORE-SCHEMA-v1
-- Private candidate. Requires Supabase auth/storage schemas and standard roles.
-- Review RPC, budget reservation RPC, project-admin and deployment are separate gates.
BEGIN;
CREATE SCHEMA labelroom_private;
REVOKE ALL ON SCHEMA labelroom_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA labelroom_private TO authenticated, service_role;

CREATE TABLE public.projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK (kind IN ('private','demo')),
 status text NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','ready','deleting')),
 quota_slot smallint,
 source_hash text CHECK (source_hash ~ '^[0-9a-f]{64}$'),
 source_bytes bigint CHECK (source_bytes BETWEEN 1 AND 26214400),
 storage_prefix text NOT NULL,
 current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision BETWEEN 0 AND 300),
 manifest jsonb CHECK (jsonb_typeof(manifest) = 'object'),
 source_label_doc jsonb CHECK (jsonb_typeof(source_label_doc) = 'object'),
 ai_consent boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
 UNIQUE (id,owner_id),
 CHECK (storage_prefix = owner_id::text || '/' || id::text),
 CHECK ((kind='private' AND quota_slot BETWEEN 1 AND 3 AND quota_slot IS NOT NULL AND expires_at IS NULL)
     OR (kind='demo' AND quota_slot IS NULL AND expires_at IS NOT NULL)),
 CHECK (status <> 'ready' OR (source_hash IS NOT NULL AND source_bytes IS NOT NULL AND manifest IS NOT NULL AND source_label_doc IS NOT NULL))
);
-- Three unique live slots enforce the quota even when concurrent reservations race.
-- The later reservation RPC must also lock the owner row and choose/retry a free slot.
CREATE UNIQUE INDEX projects_private_slots ON public.projects(owner_id,quota_slot) WHERE kind='private' AND status IN ('staging','ready');
CREATE UNIQUE INDEX projects_one_demo ON public.projects(owner_id) WHERE kind='demo';
CREATE INDEX projects_cleanup ON public.projects(status,created_at);
CREATE INDEX projects_guest_expiry ON public.projects(expires_at) WHERE kind='demo';
CREATE TABLE public.label_versions (
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK (revision BETWEEN 0 AND 300),
 label_doc jsonb NOT NULL CHECK (jsonb_typeof(label_doc)='object'),
 review_verdicts jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(review_verdicts)='object'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,revision)
);
CREATE TABLE public.mutations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL,
 project_id uuid NOT NULL, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 300), owner_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('updateCuboid','keepIssue','removeDuplicate','undo')),
 frame_id text NOT NULL CHECK(length(btrim(frame_id)) BETWEEN 1 AND 128),
 object_id text NOT NULL CHECK(length(btrim(object_id)) BETWEEN 1 AND 128),
 partner_id text CHECK(length(btrim(partner_id)) BETWEEN 1 AND 128),
 before_doc jsonb NOT NULL, after_doc jsonb NOT NULL,
 reason text NOT NULL CHECK(reason IN ('occlusion','valid-geometry','duplicate','other')),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
 undo_of uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,request_id), UNIQUE(project_id,revision), UNIQUE(project_id,id),
 FOREIGN KEY(project_id,owner_id) REFERENCES public.projects(id,owner_id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,revision) REFERENCES public.label_versions(project_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(project_id,undo_of) REFERENCES public.mutations(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((operation='removeDuplicate' AND partner_id IS NOT NULL AND partner_id<>object_id AND reason='duplicate') OR (operation<>'removeDuplicate' AND partner_id IS NULL)),
 CHECK((operation='undo' AND undo_of IS NOT NULL AND reason='other') OR (operation<>'undo' AND undo_of IS NULL))
);
CREATE TABLE public.agent_turns (
 owner_id uuid NOT NULL, turn_id uuid NOT NULL, project_id uuid NOT NULL,
 base_revision integer NOT NULL CHECK(base_revision BETWEEN 0 AND 300),
 provider_calls integer NOT NULL DEFAULT 0 CHECK(provider_calls BETWEEN 0 AND 3),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,turn_id),
 FOREIGN KEY(project_id,owner_id) REFERENCES public.projects(id,owner_id) ON DELETE CASCADE
);
CREATE TABLE public.daily_budget (
 day date NOT NULL, scope text NOT NULL CHECK(scope IN ('user','global')), owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
 turns integer NOT NULL DEFAULT 0 CHECK(turns BETWEEN 0 AND 30),
 provider_calls integer NOT NULL DEFAULT 0 CHECK(provider_calls BETWEEN 0 AND 300),
 CHECK((scope='user' AND owner_id IS NOT NULL) OR (scope='global' AND owner_id IS NULL AND turns=0))
);
CREATE UNIQUE INDEX daily_budget_user ON public.daily_budget(day,owner_id) WHERE scope='user';
CREATE UNIQUE INDEX daily_budget_global ON public.daily_budget(day) WHERE scope='global';

CREATE FUNCTION labelroom_private.guard_project() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE guest boolean;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status<>'deleting' THEN RAISE EXCEPTION 'Mark project deleting before removal' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  SELECT u.is_anonymous INTO guest FROM auth.users u WHERE u.id=NEW.owner_id;
  IF guest IS NULL OR (NEW.kind='demo') IS DISTINCT FROM guest THEN RAISE EXCEPTION 'Account kind does not match project kind' USING ERRCODE='23514'; END IF;
  IF NEW.status<>'staging' OR NEW.current_revision<>0 THEN RAISE EXCEPTION 'Reserve staging revision zero first' USING ERRCODE='23514'; END IF;
  NEW.created_at:=now(); NEW.expires_at:=CASE WHEN NEW.kind='demo' THEN now()+interval '24 hours' ELSE NULL END;
 ELSE
  IF ROW(NEW.id,NEW.owner_id,NEW.kind,NEW.storage_prefix,NEW.quota_slot,NEW.created_at,NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.owner_id,OLD.kind,OLD.storage_prefix,OLD.quota_slot,OLD.created_at,OLD.expires_at) THEN
   RAISE EXCEPTION 'Project identity is immutable' USING ERRCODE='23514';
  END IF;
  IF (OLD.status='ready' AND NEW.status NOT IN ('ready','deleting')) OR (OLD.status='deleting' AND NEW.status<>'deleting') THEN
   RAISE EXCEPTION 'Invalid project transition' USING ERRCODE='23514';
  END IF;
  IF (OLD.status='staging' AND NEW.current_revision<>0) OR (OLD.status='ready' AND NEW.current_revision NOT IN (OLD.current_revision,OLD.current_revision+1)) OR (OLD.status='deleting' AND NEW.current_revision<>OLD.current_revision) THEN
   RAISE EXCEPTION 'Invalid revision progression' USING ERRCODE='23514';
  END IF;
  IF (OLD.status<>'staging' OR EXISTS(SELECT 1 FROM public.label_versions v WHERE v.project_id=OLD.id AND v.revision=0))
   AND ROW(NEW.source_hash,NEW.source_bytes,NEW.manifest,NEW.source_label_doc) IS DISTINCT FROM ROW(OLD.source_hash,OLD.source_bytes,OLD.manifest,OLD.source_label_doc) THEN
   RAISE EXCEPTION 'Original source is immutable' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status='ready' AND (NOT EXISTS(SELECT 1 FROM public.label_versions v WHERE v.project_id=NEW.id AND v.revision=0 AND v.label_doc=NEW.source_label_doc)
   OR NOT EXISTS(SELECT 1 FROM public.label_versions v WHERE v.project_id=NEW.id AND v.revision=NEW.current_revision)) THEN
  RAISE EXCEPTION 'Ready project requires original and current snapshots' USING ERRCODE='23514';
 END IF;
 NEW.updated_at:=now(); RETURN NEW;
END $$;
CREATE TRIGGER labelroom_project_guard BEFORE INSERT OR UPDATE OR DELETE ON public.projects FOR EACH ROW EXECUTE FUNCTION labelroom_private.guard_project();
CREATE FUNCTION labelroom_private.guard_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.projects;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'History is append only' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM public.projects WHERE id=OLD.project_id;
 IF FOUND AND p.status<>'deleting' THEN RAISE EXCEPTION 'History removal requires project deletion' USING ERRCODE='23514'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER labelroom_versions_guard BEFORE UPDATE OR DELETE ON public.label_versions FOR EACH ROW EXECUTE FUNCTION labelroom_private.guard_history();
CREATE TRIGGER labelroom_mutations_guard BEFORE UPDATE OR DELETE ON public.mutations FOR EACH ROW EXECUTE FUNCTION labelroom_private.guard_history();
CREATE FUNCTION labelroom_private.guard_version_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.projects;
BEGIN
 SELECT * INTO p FROM public.projects WHERE id=NEW.project_id;
 IF NOT FOUND OR p.status='deleting' OR (NEW.revision=0 AND (p.source_label_doc IS NULL OR NEW.label_doc<>p.source_label_doc OR NEW.review_verdicts<>'{}'::jsonb)) THEN
  RAISE EXCEPTION 'Snapshot does not match project source/lifetime' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER labelroom_version_insert BEFORE INSERT ON public.label_versions FOR EACH ROW EXECUTE FUNCTION labelroom_private.guard_version_insert();

CREATE FUNCTION labelroom_private.can_read_project(project uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.projects p JOIN auth.users u ON u.id=p.owner_id
 WHERE p.id=project AND p.owner_id=(SELECT auth.uid()) AND p.status='ready'
 AND ((p.kind='private' AND u.is_anonymous=false) OR (p.kind='demo' AND u.is_anonymous=true AND p.expires_at>now())))
$$;
CREATE FUNCTION labelroom_private.can_read_object(object_name text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.projects p WHERE labelroom_private.can_read_project(p.id)
 AND (object_name=p.storage_prefix||'/original.lrx.zip' OR EXISTS(SELECT 1 FROM public.label_versions v
 WHERE v.project_id=p.id AND v.revision<=p.current_revision AND object_name=p.storage_prefix||'/exports/revision'||v.revision::text||'.lrx.zip')))
$$;
CREATE FUNCTION labelroom_private.can_upload_original(object_name text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.projects p JOIN auth.users u ON u.id=p.owner_id
 WHERE p.owner_id=(SELECT auth.uid()) AND u.is_anonymous=false AND p.kind='private' AND p.status='staging'
 AND p.created_at>now()-interval '1 hour' AND object_name=p.storage_prefix||'/original.lrx.zip')
$$;
-- Explicit table grants and no client write policies; all mutations use future fixed RPCs.
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.label_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_budget ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.projects, public.label_versions, public.mutations, public.agent_turns, public.daily_budget FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.projects, public.label_versions, public.mutations, public.agent_turns, public.daily_budget TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.projects, public.label_versions, public.mutations, public.agent_turns, public.daily_budget TO service_role;
CREATE POLICY projects_owner_read ON public.projects FOR SELECT TO authenticated USING(labelroom_private.can_read_project(id));
CREATE POLICY versions_owner_read ON public.label_versions FOR SELECT TO authenticated USING(labelroom_private.can_read_project(project_id));
CREATE POLICY mutations_owner_read ON public.mutations FOR SELECT TO authenticated USING(owner_id=(SELECT auth.uid()) AND labelroom_private.can_read_project(project_id));
CREATE POLICY turns_owner_read ON public.agent_turns FOR SELECT TO authenticated USING(owner_id=(SELECT auth.uid()) AND labelroom_private.can_read_project(project_id));
CREATE POLICY budget_owner_read ON public.daily_budget FOR SELECT TO authenticated USING(scope='user' AND owner_id=(SELECT auth.uid()));

-- Abort rather than alter an existing bucket with conflicting settings.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 VALUES('project-data','project-data',false,26214400,ARRAY['application/zip','application/octet-stream']) ON CONFLICT(id) DO NOTHING;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='project-data' AND name='project-data' AND public=false AND file_size_limit=26214400
 AND allowed_mime_types=ARRAY['application/zip','application/octet-stream']) THEN RAISE EXCEPTION 'Existing project-data bucket requires inspection'; END IF;
END $$;
-- Restrictive gates also protect project-data if another permissive policy exists.
CREATE POLICY labelroom_object_read_gate ON storage.objects AS RESTRICTIVE FOR SELECT TO anon,authenticated
 USING(bucket_id<>'project-data' OR labelroom_private.can_read_object(name));
CREATE POLICY labelroom_object_read ON storage.objects FOR SELECT TO authenticated
 USING(bucket_id='project-data' AND labelroom_private.can_read_object(name));
CREATE POLICY labelroom_object_insert_gate ON storage.objects AS RESTRICTIVE FOR INSERT TO anon,authenticated
 WITH CHECK(bucket_id<>'project-data' OR labelroom_private.can_upload_original(name));
CREATE POLICY labelroom_object_insert ON storage.objects FOR INSERT TO authenticated
 WITH CHECK(bucket_id='project-data' AND labelroom_private.can_upload_original(name));
CREATE POLICY labelroom_object_update_gate ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon,authenticated
 USING(bucket_id<>'project-data') WITH CHECK(bucket_id<>'project-data');
CREATE POLICY labelroom_object_delete_gate ON storage.objects AS RESTRICTIVE FOR DELETE TO anon,authenticated USING(bucket_id<>'project-data');
-- anon needs only schema/function access to evaluate restrictive gates: auth.uid NULL denies.
GRANT USAGE ON SCHEMA labelroom_private TO anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA labelroom_private FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION labelroom_private.can_read_project(uuid),labelroom_private.can_read_object(text),labelroom_private.can_upload_original(text) TO anon,authenticated;
COMMIT;
