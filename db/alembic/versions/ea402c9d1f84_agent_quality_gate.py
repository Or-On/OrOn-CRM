"""Immutable trusted Agent evaluation jobs and default-off publication gate.

No credentials or runtime membership grants. Actual representative dataset,
reviewed server rubric policy and explicitly authorized paid worker remain required.
"""

from alembic import op
from sqlalchemy import DDL as SchemaDDL

revision = "ea402c9d1f84"
down_revision = "e93f1b8c0e73"
branch_labels = None
depends_on = None


def _execute(script: str) -> None:
    pending = ""
    for index, part in enumerate(script.split("$$")):
        if index % 2:
            pending += "$$" + part + "$$"
            continue
        pieces = part.split(";")
        pending += pieces[0]
        for piece in pieces[1:]:
            if pending.strip():
                op.execute(pending)
            pending = piece
    if pending.strip():
        op.execute(pending)


DDL = """

DO $$ BEGIN
IF EXISTS(SELECT 1 FROM pg_auth_members membership JOIN pg_roles capability
ON capability.oid=membership.roleid OR capability.oid=membership.member
WHERE capability.rolname='platform_agent_evaluation') THEN
RAISE EXCEPTION 'review preexisting evaluation capability memberships before migration';
END IF;
IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='platform_agent_evaluation'
AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication
OR rolinherit)) THEN
RAISE EXCEPTION 'unsafe preexisting Agent evaluation role';
END IF;
IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='platform_agent_evaluation') THEN
CREATE ROLE platform_agent_evaluation NOLOGIN NOSUPERUSER NOBYPASSRLS
NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
END IF;
END $$;
CREATE TABLE agents.quality_datasets (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES
public.tenants(id) ON DELETE RESTRICT,
agent_id uuid NOT NULL REFERENCES agents.agent_profiles(id) ON DELETE RESTRICT,
provenance text NOT NULL CHECK(provenance IN ('real_anonymized', 'synthetic_fixture')),
cases jsonb NOT NULL CHECK(jsonb_typeof(cases)='array' AND jsonb_array_length(cases) BETWEEN 30
AND 200),
rubric jsonb NOT NULL CHECK(jsonb_typeof(rubric)='object'),
digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, created_at timestamptz
NOT NULL DEFAULT
clock_timestamp(),
UNIQUE(tenant_id, id), UNIQUE(tenant_id, id, agent_id)
);
CREATE TABLE agents.quality_dataset_approvals (
tenant_id uuid NOT NULL, dataset_id uuid PRIMARY KEY, approved_by uuid NOT NULL REFERENCES
public.users(id) ON DELETE RESTRICT,
approved_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz,
FOREIGN KEY(tenant_id, dataset_id) REFERENCES agents.quality_datasets(tenant_id, id) ON DELETE
RESTRICT
);
CREATE TABLE agents.quality_gate_rollouts (
tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT, enabled boolean NOT
NULL DEFAULT
false,
changed_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, changed_at timestamptz
NOT NULL DEFAULT
clock_timestamp()
);
CREATE TABLE agents.quality_evaluator_policies (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
code_digest text NOT NULL CHECK(code_digest ~ '^[0-9a-f]{64}$'),
model_policy_digest text NOT NULL CHECK(model_policy_digest ~ '^[0-9a-f]{64}$'),
rubric_digest text NOT NULL CHECK(rubric_digest ~ '^[0-9a-f]{64}$'),
approved_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, approved_at
timestamptz NOT NULL DEFAULT
clock_timestamp(),
revoked_at timestamptz, UNIQUE(code_digest, model_policy_digest, rubric_digest)
);
CREATE TABLE agents.quality_evaluation_jobs (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
agent_id uuid NOT NULL, version_id uuid NOT NULL REFERENCES agents.agent_profile_versions(id) ON
DELETE RESTRICT,
dataset_id uuid NOT NULL, snapshot_digest text NOT NULL CHECK(snapshot_digest ~
'^[0-9a-f]{64}$'),
dataset_digest text NOT NULL CHECK(dataset_digest ~ '^[0-9a-f]{64}$'),
trigger text NOT NULL CHECK(trigger IN ('manual', 'publication', 'nightly')),
requested_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, created_at
timestamptz NOT NULL DEFAULT
clock_timestamp(),
expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
state text NOT NULL CHECK(state IN ('blocked', 'pending', 'running', 'failed', 'passed',
'stale')),
worker_login text, claim_digest text, lease_until timestamptz, completed_at timestamptz,
FOREIGN KEY(tenant_id, dataset_id, agent_id) REFERENCES agents.quality_datasets(tenant_id, id,
agent_id) ON DELETE RESTRICT,
UNIQUE(tenant_id, id)
);
CREATE INDEX quality_jobs_pending ON agents.quality_evaluation_jobs(created_at) WHERE
state='pending';
CREATE TABLE agents.quality_case_attempts (
tenant_id uuid NOT NULL, job_id uuid NOT NULL, case_id uuid NOT NULL,
execution_kind text NOT NULL CHECK(execution_kind IN ('real_provider', 'mock', 'not_executed')),
stages text[] NOT NULL CHECK(cardinality(stages) BETWEEN 1 AND 3 AND stages <@ ARRAY['llm',
'stt', 'tts']::text[]),
accurate boolean NOT NULL, unsupported_numbers integer NOT NULL CHECK(unsupported_numbers>=0),
code_digest text NOT NULL CHECK(code_digest ~ '^[0-9a-f]{64}$'),
model_digest text NOT NULL CHECK(model_digest ~ '^[0-9a-f]{64}$'),
transport_digest text NOT NULL CHECK(transport_digest ~ '^[0-9a-f]{64}$'),
trace_digest text NOT NULL CHECK(trace_digest ~ '^[0-9a-f]{64}$'),
record_digest text NOT NULL CHECK(record_digest ~ '^[0-9a-f]{64}$'),
provider text NOT NULL CHECK(length(provider) BETWEEN 1 AND 80),
model text NOT NULL CHECK(length(model) BETWEEN 1 AND 160), provider_request_id text,
started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL
CHECK(finished_at>=started_at),
PRIMARY KEY(job_id, case_id), FOREIGN KEY(tenant_id, job_id) REFERENCES
agents.quality_evaluation_jobs(tenant_id, id) ON DELETE RESTRICT
);
CREATE TABLE agents.quality_evaluation_receipts (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, job_id uuid NOT NULL
UNIQUE,
version_id uuid NOT NULL, snapshot_digest text NOT NULL, dataset_digest text NOT NULL,
case_digest text NOT NULL, case_count integer NOT NULL CHECK(case_count>=30),
accurate_count integer NOT NULL CHECK(accurate_count*10>=case_count*9),
unsupported_numbers integer NOT NULL CHECK(unsupported_numbers=0),
created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
FOREIGN KEY(tenant_id, job_id) REFERENCES agents.quality_evaluation_jobs(tenant_id, id) ON
DELETE RESTRICT
);
CREATE FUNCTION platform.quality_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
RAISE EXCEPTION 'immutable quality evidence' USING ERRCODE='42501'; END $$;
CREATE TRIGGER quality_datasets_immutable BEFORE UPDATE OR DELETE ON agents.quality_datasets
FOR EACH ROW EXECUTE FUNCTION platform.quality_immutable();
CREATE TRIGGER quality_attempts_immutable BEFORE UPDATE OR DELETE ON
agents.quality_case_attempts
FOR EACH ROW EXECUTE FUNCTION platform.quality_immutable();
CREATE TRIGGER quality_receipts_immutable BEFORE UPDATE OR DELETE ON
agents.quality_evaluation_receipts
FOR EACH ROW EXECUTE FUNCTION platform.quality_immutable();
CREATE FUNCTION platform.quality_job_binding_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
IF (NEW.id, NEW.tenant_id, NEW.agent_id, NEW.version_id, NEW.dataset_id, NEW.snapshot_digest,
NEW.dataset_digest,
NEW.trigger, NEW.requested_by, NEW.created_at, NEW.expires_at) IS DISTINCT FROM
(OLD.id, OLD.tenant_id, OLD.agent_id, OLD.version_id, OLD.dataset_id, OLD.snapshot_digest,
OLD.dataset_digest,
OLD.trigger, OLD.requested_by, OLD.created_at, OLD.expires_at) THEN
RAISE EXCEPTION 'immutable quality job binding' USING ERRCODE='42501'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER quality_job_binding_immutable BEFORE UPDATE ON agents.quality_evaluation_jobs
FOR EACH ROW EXECUTE FUNCTION platform.quality_job_binding_immutable();
CREATE FUNCTION platform.quality_hash(p_value jsonb) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path=pg_catalog AS $$ SELECT encode(sha256(convert_to(p_value::text, 'UTF8')), 'hex')
$$;
CREATE FUNCTION platform.quality_snapshot(p_tenant uuid, p_version uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
SELECT platform.quality_hash(jsonb_build_object(
'version', to_jsonb(v)-'published_at'-'validation_status',
'model', to_jsonb(m)-'updated_at',
'knowledge', COALESCE((SELECT jsonb_agg(jsonb_build_object(
'source', to_jsonb(s), 'document', to_jsonb(d),
'chunks', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.ordinal, c.id)
FROM agents.knowledge_chunks c WHERE c.tenant_id=s.tenant_id AND c.document_id=d.id)) ORDER BY
s.id)
FROM agents.knowledge_sources s LEFT JOIN LATERAL (
SELECT x.* FROM agents.knowledge_documents x WHERE x.tenant_id=s.tenant_id AND x.source_id=s.id
AND x.published_at IS NOT NULL ORDER BY x.version DESC LIMIT 1
) d ON true WHERE s.tenant_id=v.tenant_id AND (v.knowledge_configuration->'sourceIds') ?
s.id::text), '[]'::jsonb)))
FROM agents.agent_profile_versions v JOIN agents.agent_profiles p
ON p.tenant_id=v.tenant_id AND p.id=v.agent_profile_id AND p.archived_at IS NULL
LEFT JOIN agents.model_configurations m ON m.tenant_id=v.tenant_id AND
m.id=v.model_configuration_id
WHERE v.id=p_version AND v.tenant_id=p_tenant
$$;
CREATE FUNCTION platform.quality_manager() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$ BEGIN
IF NOT platform.canonical_actor_authorized() THEN
RAISE EXCEPTION 'active canonical quality manager required' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION platform.quality_knowledge_current(p_tenant uuid, p_version uuid) RETURNS
boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
SELECT EXISTS(SELECT 1 FROM agents.agent_profile_versions v
JOIN agents.model_configurations m ON m.id=v.model_configuration_id AND m.tenant_id=v.tenant_id
WHERE v.id=p_version AND v.tenant_id=p_tenant AND m.is_enabled
AND jsonb_typeof(v.knowledge_configuration->'sourceIds')='array'
AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(v.knowledge_configuration->'sourceIds')
selected
WHERE NOT EXISTS(SELECT 1 FROM agents.knowledge_sources s JOIN LATERAL (
SELECT x.* FROM agents.knowledge_documents x WHERE x.source_id=s.id AND x.tenant_id=s.tenant_id
AND x.published_at IS NOT NULL ORDER BY x.version DESC LIMIT 1
) d ON true WHERE s.id::text=selected AND s.tenant_id=v.tenant_id AND s.status='published'
AND d.revoked_at IS NULL AND d.valid_from<=clock_timestamp()
AND (d.valid_until IS NULL OR d.valid_until>clock_timestamp()))))
$$;
CREATE FUNCTION platform.quality_model_digest(p_tenant uuid, p_version uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
SELECT platform.quality_hash(to_jsonb(m)-'updated_at') FROM agents.agent_profile_versions v
JOIN agents.model_configurations m ON m.id=v.model_configuration_id AND m.tenant_id=v.tenant_id
WHERE v.tenant_id=p_tenant AND v.id=p_version AND m.is_enabled
$$;
CREATE FUNCTION platform.quality_policy_current(p_dataset uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
SELECT EXISTS(SELECT 1 FROM agents.quality_datasets d JOIN agents.quality_evaluator_policies p
ON p.code_digest=d.rubric->>'evaluatorCodeDigest' AND
p.model_policy_digest=d.rubric->>'modelPolicyDigest'
AND p.rubric_digest=platform.quality_hash(d.rubric-'reviewNote'-'modelConfigurationDigest')
AND p.revoked_at IS NULL WHERE d.id=p_dataset)
$$;
CREATE FUNCTION platform.quality_lock_inputs(p_tenant uuid, p_version uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
PERFORM 1 FROM agents.agent_profile_versions WHERE tenant_id=p_tenant AND id=p_version FOR
SHARE;
PERFORM 1 FROM agents.model_configurations m JOIN agents.agent_profile_versions v
ON v.tenant_id=m.tenant_id AND v.model_configuration_id=m.id
WHERE v.tenant_id=p_tenant AND v.id=p_version FOR SHARE OF m;
PERFORM 1 FROM agents.knowledge_sources s JOIN agents.agent_profile_versions v
ON s.tenant_id=v.tenant_id AND (v.knowledge_configuration->'sourceIds') ? s.id::text
WHERE v.tenant_id=p_tenant AND v.id=p_version ORDER BY s.id FOR SHARE OF s;
PERFORM 1 FROM agents.knowledge_documents d JOIN agents.knowledge_sources s
ON s.id=d.source_id AND s.tenant_id=d.tenant_id JOIN agents.agent_profile_versions v
ON v.tenant_id=s.tenant_id AND (v.knowledge_configuration->'sourceIds') ? s.id::text
WHERE v.tenant_id=p_tenant AND v.id=p_version ORDER BY d.id FOR SHARE OF d;
END $$;
CREATE FUNCTION platform.create_quality_dataset(p_agent uuid, p_provenance text, p_cases jsonb,
p_rubric jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result uuid; BEGIN
PERFORM platform.quality_manager();
IF NOT EXISTS(SELECT 1 FROM agents.agent_profiles WHERE tenant_id=platform.current_tenant_id()
AND id=p_agent AND archived_at IS NULL) THEN
RAISE EXCEPTION 'Agent unavailable' USING ERRCODE='42501'; END IF;
IF p_cases IS NULL OR jsonb_typeof(p_cases)<>'array' OR jsonb_array_length(p_cases) NOT BETWEEN
30 AND 200
OR p_rubric IS NULL OR jsonb_typeof(p_rubric)<>'object' OR length(p_cases::text)>1000000
OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_cases) c WHERE
jsonb_typeof(c)<>'object' OR COALESCE(c->>'id', '') !~
'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
OR length(COALESCE(c->>'input', '')) NOT BETWEEN 1 AND 16000
OR COALESCE(c->>'channel', '') NOT IN ('voice', 'whatsapp')
OR jsonb_typeof(c->'expected') IS DISTINCT FROM 'object')
OR (SELECT count(DISTINCT c->>'id') FROM jsonb_array_elements(p_cases)
c)<>jsonb_array_length(p_cases)
THEN RAISE EXCEPTION 'invalid bounded golden dataset' USING ERRCODE='22023'; END IF;
INSERT INTO agents.quality_datasets(tenant_id, agent_id, provenance, cases, rubric, digest,
created_by)
VALUES(platform.current_tenant_id(), p_agent, p_provenance, p_cases, p_rubric,
platform.quality_hash(jsonb_build_object('cases', p_cases, 'rubric', p_rubric, 'agent', p_agent,
'provenance', p_provenance)),
platform.current_user_id()) RETURNING id INTO result;
INSERT INTO audit.records(tenant_id, actor_user_id, action, target_type, target_id)
VALUES(platform.current_tenant_id(), platform.current_user_id(),
'agent.quality_dataset_created', 'agent_quality_dataset', result);
RETURN result;
END $$;
CREATE FUNCTION platform.approve_quality_dataset(p_dataset uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE d
agents.quality_datasets; BEGIN
PERFORM platform.quality_manager();
SELECT * INTO d FROM agents.quality_datasets WHERE tenant_id=platform.current_tenant_id() AND
id=p_dataset;
IF d.id IS NULL OR d.provenance<>'real_anonymized' THEN
RAISE EXCEPTION 'reviewed real anonymized dataset required' USING ERRCODE='22023'; END IF;
IF COALESCE(d.rubric->>'version', '')='' OR COALESCE(d.rubric->>'accuracyMetric', '')=''
OR COALESCE(d.rubric->>'numberGroundingMetric', '')='' OR COALESCE(d.rubric->>'reviewNote',
'')=''
OR COALESCE(d.rubric->>'evaluatorCodeDigest', '') !~ '^[0-9a-f]{64}$'
OR COALESCE(d.rubric->>'modelPolicyDigest', '') !~ '^[0-9a-f]{64}$'
OR COALESCE(d.rubric->>'modelConfigurationDigest', '') !~ '^[0-9a-f]{64}$'
OR d.rubric->>'minimumAccuracy' IS DISTINCT FROM '0.9'
OR d.rubric->>'maximumUnsupportedNumbers' IS DISTINCT FROM '0'
THEN RAISE EXCEPTION 'explicit reviewed PDF scoring policy required' USING ERRCODE='22023'; END
IF;
IF NOT platform.quality_policy_current(d.id) THEN
RAISE EXCEPTION 'server reviewed evaluator policy unavailable' USING ERRCODE='55000'; END IF;
INSERT INTO agents.quality_dataset_approvals(tenant_id, dataset_id, approved_by)
VALUES(d.tenant_id, d.id, platform.current_user_id()) ON CONFLICT(dataset_id) DO NOTHING;
INSERT INTO audit.records(tenant_id, actor_user_id, action, target_type, target_id)
VALUES(d.tenant_id, platform.current_user_id(), 'agent.quality_dataset_approved',
'agent_quality_dataset', d.id);
END $$;
CREATE FUNCTION platform.revoke_quality_dataset(p_dataset uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
PERFORM platform.quality_manager();
UPDATE agents.quality_dataset_approvals SET revoked_at=COALESCE(revoked_at, clock_timestamp())
WHERE tenant_id=platform.current_tenant_id() AND dataset_id=p_dataset;
INSERT INTO audit.records(tenant_id, actor_user_id, action, target_type, target_id)
VALUES(platform.current_tenant_id(), platform.current_user_id(),
'agent.quality_dataset_revoked', 'agent_quality_dataset', p_dataset);
END $$;
CREATE FUNCTION platform.set_agent_quality_gate(p_enabled boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
PERFORM platform.quality_manager();
IF p_enabled IS NULL THEN RAISE EXCEPTION 'gate state required' USING ERRCODE='22023'; END IF;
INSERT INTO agents.quality_gate_rollouts(tenant_id, enabled, changed_by)
VALUES(platform.current_tenant_id(), p_enabled, platform.current_user_id())
ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled, changed_by=EXCLUDED.changed_by,
changed_at=clock_timestamp();
INSERT INTO audit.records(tenant_id, actor_user_id, action, target_type, metadata)
VALUES(platform.current_tenant_id(), platform.current_user_id(), 'agent.quality_gate_changed',
'tenant', jsonb_build_object('enabled', p_enabled));
RETURN p_enabled;
END $$;
CREATE FUNCTION platform.current_agent_quality_gate_enabled() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
PERFORM platform.quality_manager();
RETURN EXISTS(SELECT 1 FROM agents.quality_gate_rollouts WHERE
tenant_id=platform.current_tenant_id() AND enabled);
END $$;
CREATE FUNCTION platform.list_approved_agent_quality_datasets(p_agent uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
PERFORM platform.quality_manager();
RETURN COALESCE((SELECT jsonb_agg(result ORDER BY approved_at DESC) FROM(
SELECT a.approved_at, jsonb_build_object('id', d.id, 'digest', d.digest, 'rubricVersion',
d.rubric->>'version',
'approvedAt', a.approved_at) result FROM agents.quality_datasets d JOIN
agents.quality_dataset_approvals a
ON a.dataset_id=d.id AND a.tenant_id=d.tenant_id AND a.revoked_at IS NULL
WHERE d.tenant_id=platform.current_tenant_id() AND d.agent_id=p_agent AND
d.provenance='real_anonymized'
AND platform.quality_policy_current(d.id) ORDER BY a.approved_at DESC, d.id LIMIT 50) selected),
'[]'::jsonb);
END $$;
CREATE FUNCTION platform.request_agent_quality_evaluation(p_version uuid, p_dataset uuid,
p_trigger text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result uuid; d agents.quality_datasets; v agents.agent_profile_versions; BEGIN
PERFORM platform.quality_manager();
IF NOT platform.current_agent_quality_gate_enabled() THEN
RAISE EXCEPTION 'Agent quality rollout disabled' USING ERRCODE='55000'; END IF;
PERFORM
pg_advisory_xact_lock(hashtextextended('agent_quality_tenant:'||platform.current_tenant_id()::text,
0));
SELECT * INTO v FROM agents.agent_profile_versions WHERE tenant_id=platform.current_tenant_id()
AND id=p_version FOR UPDATE;
SELECT * INTO d FROM agents.quality_datasets WHERE tenant_id=platform.current_tenant_id() AND
id=p_dataset AND agent_id=v.agent_profile_id;
IF v.id IS NULL OR d.id IS NULL THEN RAISE EXCEPTION 'quality binding unavailable' USING
ERRCODE='42501'; END IF;
PERFORM platform.quality_lock_inputs(v.tenant_id, v.id);
SELECT id INTO result FROM agents.quality_evaluation_jobs WHERE tenant_id=v.tenant_id AND
version_id=v.id
AND dataset_id=d.id AND snapshot_digest=platform.quality_snapshot(v.tenant_id, v.id)
AND expires_at>clock_timestamp() AND state IN ('blocked', 'pending', 'running', 'passed')
ORDER BY created_at DESC, id LIMIT 1;
IF result IS NOT NULL THEN RETURN result; END IF;
IF (SELECT count(*) FROM agents.quality_evaluation_jobs WHERE tenant_id=v.tenant_id
AND expires_at>clock_timestamp() AND state IN ('blocked', 'pending', 'running'))>=100 THEN
RAISE EXCEPTION 'bounded quality evaluation backlog full' USING ERRCODE='54000'; END IF;
INSERT INTO agents.quality_evaluation_jobs(tenant_id, agent_id, version_id, dataset_id,
snapshot_digest, dataset_digest, trigger, requested_by, state)
VALUES(v.tenant_id, v.agent_profile_id, v.id, d.id, platform.quality_snapshot(v.tenant_id,
v.id), d.digest, p_trigger, platform.current_user_id(),
CASE WHEN d.provenance='real_anonymized' AND EXISTS(SELECT 1 FROM
agents.quality_dataset_approvals
WHERE dataset_id=d.id AND tenant_id=d.tenant_id AND revoked_at IS NULL) THEN 'pending' ELSE
'blocked' END)
RETURNING id INTO result;
INSERT INTO audit.records(tenant_id, actor_user_id, action, target_type, target_id)
VALUES(v.tenant_id, platform.current_user_id(), 'agent.quality_evaluation_requested',
'agent_quality_job', result);
RETURN result;
END $$;
CREATE FUNCTION platform.claim_agent_quality_evaluation() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agents.quality_evaluation_jobs; token uuid:=gen_random_uuid(); BEGIN
PERFORM pg_advisory_xact_lock(hashtextextended('agent_quality_claim', 0));
IF (SELECT count(*) FROM agents.quality_evaluation_jobs WHERE state='running'
AND lease_until>clock_timestamp())>=2 THEN RETURN NULL; END IF;
SELECT * INTO j FROM agents.quality_evaluation_jobs WHERE
(state='pending' OR (state='running' AND lease_until<=clock_timestamp())) AND
expires_at>clock_timestamp()
AND NOT EXISTS(SELECT 1 FROM agents.quality_evaluation_jobs active WHERE
active.tenant_id=quality_evaluation_jobs.tenant_id
AND active.state='running' AND active.lease_until>clock_timestamp())
ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1;
IF j.id IS NULL THEN RETURN NULL; END IF;
UPDATE agents.quality_evaluation_jobs SET state='running', worker_login=session_user,
claim_digest=platform.quality_hash(to_jsonb(token::text)),
lease_until=clock_timestamp()+interval '10 minutes' WHERE id=j.id;
RETURN jsonb_build_object('jobId', j.id, 'tenantId', j.tenant_id, 'versionId', j.version_id,
'datasetId', j.dataset_id, 'snapshotDigest', j.snapshot_digest, 'claimToken', token,
'dataset', (SELECT jsonb_build_object('cases', cases, 'rubric', rubric, 'provenance',
provenance)
FROM agents.quality_datasets WHERE id=j.dataset_id AND tenant_id=j.tenant_id),
'completedCaseIds', (SELECT COALESCE(jsonb_agg(case_id ORDER BY case_id), '[]'::jsonb)
FROM agents.quality_case_attempts WHERE job_id=j.id AND tenant_id=j.tenant_id));
END $$;
CREATE FUNCTION platform.queue_nightly_agent_quality_evaluations(p_limit integer) RETURNS
integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item record; snapshot text; job_id uuid; queued integer:=0; BEGIN
IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
RAISE EXCEPTION 'bounded nightly producer limit required' USING ERRCODE='22023'; END IF;
FOR item IN SELECT v.id version_id, v.agent_profile_id, v.tenant_id, d.id dataset_id, d.digest,
a.approved_by
FROM agents.agent_profiles profile JOIN public.tenants t ON t.id=profile.tenant_id AND
t.status='active'
JOIN agents.quality_gate_rollouts rollout ON rollout.tenant_id=t.id AND rollout.enabled
JOIN LATERAL(SELECT x.* FROM agents.agent_profile_versions x WHERE x.agent_profile_id=profile.id
AND x.tenant_id=profile.tenant_id AND x.published_at IS NOT NULL ORDER BY x.version DESC LIMIT
1) v ON true
JOIN LATERAL(SELECT x.* FROM agents.quality_datasets x JOIN agents.quality_dataset_approvals
approval
ON approval.dataset_id=x.id AND approval.tenant_id=x.tenant_id AND approval.revoked_at IS NULL
WHERE x.agent_id=profile.id AND x.tenant_id=profile.tenant_id AND x.provenance='real_anonymized'
AND platform.quality_policy_current(x.id) ORDER BY approval.approved_at DESC, x.id LIMIT 1) d ON
true
JOIN agents.quality_dataset_approvals a ON a.dataset_id=d.id
JOIN public.users reviewer ON reviewer.id=a.approved_by AND reviewer.status='active'
WHERE profile.archived_at IS NULL AND (reviewer.is_superuser OR EXISTS(SELECT 1 FROM
public.memberships m
WHERE m.tenant_id=t.id AND m.user_id=reviewer.id AND m.role IN ('owner', 'admin')))
ORDER BY t.id, profile.id LIMIT p_limit
LOOP
PERFORM pg_advisory_xact_lock(hashtextextended('agent_quality_tenant:'||item.tenant_id::text,
0));
PERFORM 1 FROM agents.agent_profile_versions WHERE id=item.version_id FOR UPDATE;
PERFORM platform.quality_lock_inputs(item.tenant_id, item.version_id);
snapshot:=platform.quality_snapshot(item.tenant_id, item.version_id);
IF NOT platform.quality_knowledge_current(item.tenant_id, item.version_id) OR EXISTS(
SELECT 1 FROM agents.quality_evaluation_jobs WHERE tenant_id=item.tenant_id AND
version_id=item.version_id
AND dataset_id=item.dataset_id AND snapshot_digest=snapshot AND
created_at>clock_timestamp()-interval '20 hours')
OR (SELECT count(*) FROM agents.quality_evaluation_jobs WHERE tenant_id=item.tenant_id
AND expires_at>clock_timestamp() AND state IN ('pending', 'running', 'blocked'))>=100 THEN
CONTINUE; END IF;
INSERT INTO agents.quality_evaluation_jobs(tenant_id, agent_id, version_id, dataset_id,
snapshot_digest, dataset_digest,
trigger, requested_by, state) VALUES(item.tenant_id, item.agent_profile_id, item.version_id,
item.dataset_id, snapshot,
item.digest, 'nightly', item.approved_by, 'pending') RETURNING id INTO job_id;
INSERT INTO audit.records(tenant_id, actor_user_id, action, target_type, target_id, metadata)
VALUES(item.tenant_id, item.approved_by, 'agent.quality_nightly_requested', 'agent_quality_job',
job_id,
jsonb_build_object('executorRole', 'platform_agent_evaluation'));
queued:=queued+1;
END LOOP;
RETURN queued;
END $$;
CREATE FUNCTION platform.append_agent_quality_case(p_job uuid, p_token uuid, p_case uuid,
p_record jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agents.quality_evaluation_jobs; existing text; BEGIN
SELECT * INTO j FROM agents.quality_evaluation_jobs WHERE id=p_job FOR UPDATE;
IF j.id IS NULL OR j.state<>'running' OR j.worker_login IS DISTINCT FROM session_user
OR j.claim_digest IS DISTINCT FROM platform.quality_hash(to_jsonb(p_token::text)) OR
j.lease_until<=clock_timestamp()
THEN RAISE EXCEPTION 'quality worker claim denied' USING ERRCODE='42501'; END IF;
IF NOT EXISTS(SELECT 1 FROM agents.quality_datasets d CROSS JOIN LATERAL
jsonb_array_elements(d.cases) c
WHERE d.id=j.dataset_id AND d.tenant_id=j.tenant_id AND c->>'id'=p_case::text)
THEN RAISE EXCEPTION 'case not in claimed dataset' USING ERRCODE='42501'; END IF;
IF p_record IS NULL OR jsonb_typeof(p_record)<>'object' OR length(p_record::text)>10000
OR length(COALESCE(p_record->>'providerRequestId', ''))>256
OR jsonb_typeof(p_record->'accurate') IS DISTINCT FROM 'boolean'
OR jsonb_typeof(p_record->'unsupportedNumbers') IS DISTINCT FROM 'number'
OR jsonb_typeof(p_record->'stages') IS DISTINCT FROM 'array'
OR (p_record->>'unsupportedNumbers') !~ '^[0-9]{1,6}$'
OR (p_record->>'startedAt')::timestamptz<j.created_at
OR (p_record->>'finishedAt')::timestamptz>clock_timestamp()+interval '5 seconds' THEN
RAISE EXCEPTION 'bounded trusted transport record required' USING ERRCODE='22023'; END IF;
SELECT record_digest INTO existing FROM agents.quality_case_attempts WHERE job_id=j.id AND
case_id=p_case;
IF existing IS NOT NULL THEN
IF existing=platform.quality_hash(p_record) THEN RETURN; END IF;
RAISE EXCEPTION 'case attempt replay changed evidence' USING ERRCODE='42501'; END IF;
INSERT INTO agents.quality_case_attempts(tenant_id, job_id, case_id, execution_kind, stages,
accurate, unsupported_numbers,
code_digest, model_digest, transport_digest, trace_digest, record_digest, provider, model,
provider_request_id, started_at, finished_at)
VALUES(j.tenant_id, j.id, p_case, p_record->>'executionKind', ARRAY(SELECT
jsonb_array_elements_text(p_record->'stages')),
(p_record->>'accurate')::boolean, (p_record->>'unsupportedNumbers')::integer,
p_record->>'codeDigest', p_record->>'modelDigest', p_record->>'transportDigest',
p_record->>'traceDigest', platform.quality_hash(p_record),
p_record->>'provider', p_record->>'model', p_record->>'providerRequestId',
(p_record->>'startedAt')::timestamptz, (p_record->>'finishedAt')::timestamptz);
END $$;
CREATE FUNCTION platform.finalize_agent_quality_evaluation(p_job uuid, p_token uuid) RETURNS
uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agents.quality_evaluation_jobs; d agents.quality_datasets; n integer; good integer;
bad integer; receipt uuid; BEGIN
SELECT * INTO j FROM agents.quality_evaluation_jobs WHERE id=p_job FOR UPDATE;
IF j.id IS NOT NULL AND j.state='passed' AND j.worker_login=session_user
AND j.claim_digest=platform.quality_hash(to_jsonb(p_token::text)) THEN
RETURN (SELECT id FROM agents.quality_evaluation_receipts WHERE job_id=j.id); END IF;
IF j.id IS NULL OR j.state<>'running' OR j.worker_login IS DISTINCT FROM session_user
OR j.claim_digest IS DISTINCT FROM platform.quality_hash(to_jsonb(p_token::text)) OR
j.lease_until<=clock_timestamp()
THEN RAISE EXCEPTION 'quality worker claim denied' USING ERRCODE='42501'; END IF;
SELECT * INTO d FROM agents.quality_datasets WHERE id=j.dataset_id AND tenant_id=j.tenant_id;
PERFORM platform.quality_lock_inputs(j.tenant_id, j.version_id);
PERFORM 1 FROM agents.quality_dataset_approvals WHERE dataset_id=d.id AND tenant_id=d.tenant_id
FOR SHARE;
PERFORM 1 FROM agents.quality_evaluator_policies WHERE
code_digest=d.rubric->>'evaluatorCodeDigest'
AND model_policy_digest=d.rubric->>'modelPolicyDigest' FOR SHARE;
IF d.provenance<>'real_anonymized' OR d.digest<>j.dataset_digest OR NOT
platform.quality_policy_current(d.id) OR NOT EXISTS(
SELECT 1 FROM agents.quality_dataset_approvals WHERE dataset_id=d.id AND tenant_id=d.tenant_id
AND revoked_at IS NULL)
THEN RAISE EXCEPTION 'approved real dataset and policy required' USING ERRCODE='55000'; END IF;
IF platform.quality_snapshot(j.tenant_id, j.version_id) IS DISTINCT FROM j.snapshot_digest OR
j.expires_at<=clock_timestamp()
OR NOT platform.quality_knowledge_current(j.tenant_id, j.version_id)
OR platform.quality_model_digest(j.tenant_id, j.version_id) IS DISTINCT FROM
d.rubric->>'modelConfigurationDigest'
THEN RAISE EXCEPTION 'evaluation snapshot stale' USING ERRCODE='55000'; END IF;
SELECT count(*), count(*) FILTER(WHERE accurate), COALESCE(sum(unsupported_numbers), 0) INTO n,
good, bad
FROM agents.quality_case_attempts WHERE job_id=j.id AND tenant_id=j.tenant_id;
IF n<>jsonb_array_length(d.cases) OR n<30 OR good*10<n*9 OR bad<>0 OR EXISTS(
SELECT 1 FROM agents.quality_case_attempts WHERE job_id=j.id AND
(execution_kind<>'real_provider'
OR code_digest IS DISTINCT FROM d.rubric->>'evaluatorCodeDigest' OR model_digest IS DISTINCT
FROM d.rubric->>'modelConfigurationDigest'))
OR EXISTS(SELECT 1 FROM agents.quality_case_attempts a JOIN agents.agent_profile_versions v
ON v.id=j.version_id AND v.tenant_id=j.tenant_id JOIN agents.model_configurations m ON
m.id=v.model_configuration_id
AND m.tenant_id=v.tenant_id WHERE a.job_id=j.id AND (a.provider<>m.provider OR
a.model<>m.model))
OR EXISTS(SELECT 1 FROM agents.quality_case_attempts a CROSS JOIN LATERAL
jsonb_array_elements(d.cases) c
WHERE a.job_id=j.id AND c->>'id'=a.case_id::text AND
NOT a.stages @> CASE WHEN c->>'channel'='voice' THEN ARRAY['llm', 'stt', 'tts']::text[] ELSE
ARRAY['llm']::text[] END)
THEN RAISE EXCEPTION 'complete physical golden suite did not pass PDF policy' USING
ERRCODE='55000'; END IF;
INSERT INTO agents.quality_evaluation_receipts(tenant_id, job_id, version_id, snapshot_digest,
dataset_digest, case_digest,
case_count, accurate_count, unsupported_numbers, expires_at)
VALUES(j.tenant_id, j.id, j.version_id, j.snapshot_digest, j.dataset_digest,
(SELECT platform.quality_hash(jsonb_agg(to_jsonb(a) ORDER BY case_id)) FROM
agents.quality_case_attempts a WHERE job_id=j.id),
n, good, bad, j.expires_at) RETURNING id INTO receipt;
UPDATE agents.quality_evaluation_jobs SET state='passed', completed_at=clock_timestamp() WHERE
id=j.id;
RETURN receipt;
END $$;
CREATE FUNCTION platform.fail_agent_quality_evaluation(p_job uuid, p_token uuid, p_code text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE j
agents.quality_evaluation_jobs; BEGIN
SELECT * INTO j FROM agents.quality_evaluation_jobs WHERE id=p_job FOR UPDATE;
IF j.id IS NULL OR j.state<>'running' OR j.worker_login IS DISTINCT FROM session_user
OR j.claim_digest IS DISTINCT FROM platform.quality_hash(to_jsonb(p_token::text)) OR
j.lease_until<=clock_timestamp()
THEN RAISE EXCEPTION 'quality worker claim denied' USING ERRCODE='42501'; END IF;
IF p_code IS NULL OR p_code !~ '^[a-z_]{1,80}$' THEN
RAISE EXCEPTION 'bounded failure code required' USING ERRCODE='22023'; END IF;
UPDATE agents.quality_evaluation_jobs SET state='failed', completed_at=clock_timestamp() WHERE
id=j.id;
INSERT INTO audit.records(tenant_id, actor_user_id, action, target_type, target_id, metadata)
VALUES(j.tenant_id, j.requested_by, 'agent.quality_evaluation_failed', 'agent_quality_job',
j.id,
jsonb_build_object('code', p_code, 'executorRole', 'platform_agent_evaluation'));
END $$;
CREATE FUNCTION platform.assert_agent_quality_publishable(p_version uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
PERFORM platform.quality_manager();
IF NOT EXISTS(SELECT 1 FROM agents.quality_gate_rollouts WHERE
tenant_id=platform.current_tenant_id() AND enabled) THEN RETURN; END IF;
PERFORM platform.quality_lock_inputs(platform.current_tenant_id(), p_version);
PERFORM 1 FROM agents.quality_dataset_approvals WHERE tenant_id=platform.current_tenant_id() FOR
SHARE;
PERFORM 1 FROM agents.quality_evaluator_policies FOR SHARE;
IF NOT platform.quality_knowledge_current(platform.current_tenant_id(), p_version) THEN
RAISE EXCEPTION 'evaluation model or knowledge no longer eligible' USING ERRCODE='55000'; END
IF;
IF NOT EXISTS(SELECT 1 FROM agents.quality_evaluation_receipts r JOIN
agents.quality_evaluation_jobs j ON j.id=r.job_id
JOIN agents.quality_dataset_approvals a ON a.dataset_id=j.dataset_id AND a.tenant_id=j.tenant_id
AND a.revoked_at IS NULL
WHERE r.tenant_id=platform.current_tenant_id() AND r.version_id=p_version AND
r.expires_at>clock_timestamp()
AND j.state='passed' AND platform.quality_policy_current(j.dataset_id)
AND r.snapshot_digest=platform.quality_snapshot(r.tenant_id, p_version))
THEN RAISE EXCEPTION 'current passing real golden evaluation required' USING ERRCODE='55000';
END IF;
END $$;
CREATE FUNCTION platform.list_agent_quality_evaluations(p_version uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
PERFORM platform.quality_manager();
RETURN COALESCE((SELECT jsonb_agg(result ORDER BY created_at DESC) FROM (
SELECT j.created_at, jsonb_build_object('id', j.id, 'state', j.state, 'createdAt', j.created_at,
'completedAt', j.completed_at, 'expiresAt', j.expires_at, 'datasetId', j.dataset_id,
'hasAcceptedReceipt', EXISTS(SELECT 1 FROM agents.quality_evaluation_receipts r WHERE
r.job_id=j.id)) result
FROM agents.quality_evaluation_jobs j WHERE j.tenant_id=platform.current_tenant_id() AND
j.version_id=p_version
ORDER BY j.created_at DESC, j.id LIMIT 50) selected), '[]'::jsonb);
END $$;"""


def upgrade() -> None:
    _execute(DDL)
    op.execute("ALTER TABLE agents.quality_evaluator_policies ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE agents.quality_evaluator_policies FORCE ROW LEVEL SECURITY")
    op.execute("""
      CREATE POLICY quality_evaluator_policies_deny_all ON agents.quality_evaluator_policies
      USING(false) WITH CHECK(false)
    """)
    # Explicit deny-all and no grants: only reviewed migrator provisioning admits policies.
    tables = (
        "quality_datasets",
        "quality_dataset_approvals",
        "quality_gate_rollouts",
        "quality_evaluation_jobs",
        "quality_case_attempts",
        "quality_evaluation_receipts",
    )
    for name in tables:
        # Identifiers are exclusively the closed migration-owned tuple above.
        for statement in (
            "ALTER TABLE agents.%(table)s ENABLE ROW LEVEL SECURITY",
            "ALTER TABLE agents.%(table)s FORCE ROW LEVEL SECURITY",
            "CREATE POLICY %(table)s_isolation ON agents.%(table)s "
            "USING(tenant_id=platform.current_tenant_id() "
            "AND platform.canonical_actor_authorized()) "
            "WITH CHECK(tenant_id=platform.current_tenant_id() "
            "AND platform.canonical_actor_authorized())",
        ):
            op.execute(SchemaDDL(statement, context={"table": name}))
    for signature in (
        "quality_immutable()",
        "quality_hash(jsonb)",
        "quality_snapshot(uuid,uuid)",
        "quality_manager()",
        "quality_knowledge_current(uuid,uuid)",
        "quality_model_digest(uuid,uuid)",
        "quality_policy_current(uuid)",
        "quality_job_binding_immutable()",
        "quality_lock_inputs(uuid,uuid)",
        "create_quality_dataset(uuid,text,jsonb,jsonb)",
        "approve_quality_dataset(uuid)",
        "revoke_quality_dataset(uuid)",
        "set_agent_quality_gate(boolean)",
        "current_agent_quality_gate_enabled()",
        "list_approved_agent_quality_datasets(uuid)",
        "request_agent_quality_evaluation(uuid,uuid,text)",
        "claim_agent_quality_evaluation()",
        "queue_nightly_agent_quality_evaluations(integer)",
        "append_agent_quality_case(uuid,uuid,uuid,jsonb)",
        "finalize_agent_quality_evaluation(uuid,uuid)",
        "fail_agent_quality_evaluation(uuid,uuid,text)",
        "assert_agent_quality_publishable(uuid)",
        "list_agent_quality_evaluations(uuid)",
    ):
        op.execute(
            SchemaDDL(
                "REVOKE ALL ON FUNCTION platform.%(signature)s FROM PUBLIC",
                context={"signature": signature},
            )
        )
    for signature in (
        "create_quality_dataset(uuid,text,jsonb,jsonb)",
        "approve_quality_dataset(uuid)",
        "revoke_quality_dataset(uuid)",
        "set_agent_quality_gate(boolean)",
        "current_agent_quality_gate_enabled()",
        "list_approved_agent_quality_datasets(uuid)",
        "request_agent_quality_evaluation(uuid,uuid,text)",
        "assert_agent_quality_publishable(uuid)",
        "list_agent_quality_evaluations(uuid)",
    ):
        op.execute(
            SchemaDDL(
                "GRANT EXECUTE ON FUNCTION platform.%(signature)s TO platform_web",
                context={"signature": signature},
            )
        )
    op.execute("GRANT USAGE ON SCHEMA platform TO platform_agent_evaluation")
    for signature in (
        "claim_agent_quality_evaluation()",
        "append_agent_quality_case(uuid,uuid,uuid,jsonb)",
        "finalize_agent_quality_evaluation(uuid,uuid)",
        "fail_agent_quality_evaluation(uuid,uuid,text)",
        "queue_nightly_agent_quality_evaluations(integer)",
    ):
        op.execute(
            SchemaDDL(
                "GRANT EXECUTE ON FUNCTION platform.%(signature)s TO platform_agent_evaluation",
                context={"signature": signature},
            )
        )


def downgrade() -> None:
    # Empty, never-enabled installation is reversible; evidence deletion requires archival review.
    op.execute("""DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM agents.quality_datasets)
        OR EXISTS(SELECT 1 FROM agents.quality_evaluation_jobs)
        OR EXISTS(SELECT 1 FROM agents.quality_evaluation_receipts)
        OR EXISTS(SELECT 1 FROM agents.quality_evaluator_policies)
        OR EXISTS(SELECT 1 FROM agents.quality_gate_rollouts WHERE enabled) THEN
        RAISE EXCEPTION 'quality evidence archival review required before downgrade';
      END IF;
    END $$""")
    for name in (
        "quality_evaluation_receipts",
        "quality_case_attempts",
        "quality_evaluation_jobs",
        "quality_dataset_approvals",
        "quality_gate_rollouts",
        "quality_datasets",
        "quality_evaluator_policies",
    ):
        op.execute(SchemaDDL("DROP TABLE agents.%(table)s", context={"table": name}))
    for signature in (
        "list_agent_quality_evaluations(uuid)",
        "assert_agent_quality_publishable(uuid)",
        "fail_agent_quality_evaluation(uuid,uuid,text)",
        "finalize_agent_quality_evaluation(uuid,uuid)",
        "append_agent_quality_case(uuid,uuid,uuid,jsonb)",
        "queue_nightly_agent_quality_evaluations(integer)",
        "claim_agent_quality_evaluation()",
        "request_agent_quality_evaluation(uuid,uuid,text)",
        "list_approved_agent_quality_datasets(uuid)",
        "current_agent_quality_gate_enabled()",
        "set_agent_quality_gate(boolean)",
        "revoke_quality_dataset(uuid)",
        "approve_quality_dataset(uuid)",
        "create_quality_dataset(uuid,text,jsonb,jsonb)",
        "quality_lock_inputs(uuid,uuid)",
        "quality_policy_current(uuid)",
        "quality_model_digest(uuid,uuid)",
        "quality_knowledge_current(uuid,uuid)",
        "quality_manager()",
        "quality_snapshot(uuid,uuid)",
        "quality_hash(jsonb)",
        "quality_job_binding_immutable()",
        "quality_immutable()",
    ):
        op.execute(
            SchemaDDL("DROP FUNCTION platform.%(signature)s", context={"signature": signature})
        )
    op.execute("REVOKE USAGE ON SCHEMA platform FROM platform_agent_evaluation")
    # Cluster-global role may be referenced by other databases; retain its inert NOLOGIN identity.
