"""Bind physical golden evidence to the exact staged publication context."""

# ruff: noqa: E501
import re

from alembic import op

revision = "a3ae6075bf24"
down_revision = "a29d5f64ae13"
branch_labels = None
depends_on = None


def _execute(script: str) -> None:
    statement = ""
    for index, chunk in enumerate(re.split(r"(\$\$.*?\$\$|'(?:''|[^'])*')", script, flags=re.S)):
        if index % 2:
            statement += chunk
            continue
        fragments = chunk.split(";")
        for fragment in fragments[:-1]:
            statement += fragment
            if statement.strip():
                op.execute(statement)
            statement = ""
        statement += fragments[-1]
    if statement.strip():
        op.execute(statement)


SQL = """
ALTER TABLE automation.publication_operations ADD COLUMN candidate_snapshot jsonb,ADD COLUMN candidate_digest text;
CREATE TABLE agents.publication_evaluation_contexts(
  tenant_id uuid NOT NULL,job_id uuid PRIMARY KEY REFERENCES agents.quality_evaluation_jobs(id),
  operation_id uuid NOT NULL,candidate_digest text NOT NULL CHECK(length(candidate_digest)=64),
  FOREIGN KEY(tenant_id,operation_id) REFERENCES automation.publication_operations(tenant_id,id)
);
ALTER TABLE agents.publication_evaluation_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.publication_evaluation_contexts FORCE ROW LEVEL SECURITY;
CREATE POLICY publication_evaluation_scope ON agents.publication_evaluation_contexts USING(tenant_id=platform.current_tenant_id());
CREATE FUNCTION platform.publication_candidate_snapshot(p_operation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o automation.publication_operations; active platform.tenant_configuration_releases; resource jsonb; version_ids uuid[]; profiles jsonb;
BEGIN
 SELECT * INTO o FROM automation.publication_operations WHERE tenant_id=platform.current_tenant_id() AND id=p_operation;
 IF o.id IS NULL THEN RAISE EXCEPTION 'publication unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO active FROM platform.tenant_configuration_releases WHERE tenant_id=o.tenant_id AND status='published' ORDER BY version DESC LIMIT 1;
 IF o.kind='agent' THEN
   SELECT to_jsonb(v)-'created_at'-'published_at' INTO resource FROM agents.agent_profile_versions v WHERE v.tenant_id=o.tenant_id AND v.id=o.candidate_id;
   version_ids:=ARRAY[o.candidate_id];
 ELSIF o.kind='canonical' THEN
   SELECT to_jsonb(v)-'created_at'-'published_at',ARRAY[v.agent_profile_version_id] INTO resource,version_ids FROM automation.flow_versions v WHERE v.tenant_id=o.tenant_id AND v.id=o.candidate_id;
 ELSE
   SELECT jsonb_build_object('flowId',f.flow_id,'version',f.version,'source',f.source,'spec',f.spec,'componentsVersion',f.components_version) INTO resource FROM public.flows f WHERE f.tenant_id=o.tenant_id AND f.flow_id=o.resource_id AND f.version=o.candidate_version;
   SELECT array_agg(DISTINCT v.agent_profile_version_id) INTO version_ids FROM automation.flow_versions v
    JOIN automation.tenant_processes p ON p.tenant_id=v.tenant_id AND p.flow_version_id=v.id AND p.enabled
    WHERE v.tenant_id=o.tenant_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.definition->'nodes') n WHERE n->>'type'='voice.call' AND n#>>'{configuration,flowId}'=o.resource_id::text);
 END IF;
 IF resource IS NULL THEN RAISE EXCEPTION 'publication source unavailable' USING ERRCODE='55000';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('agentVersionId',v.id,'agentProfileId',v.agent_profile_id,'snapshot',platform.quality_snapshot(v.tenant_id,v.id)) ORDER BY v.id),'[]') INTO profiles
  FROM agents.agent_profile_versions v WHERE v.tenant_id=o.tenant_id AND v.id=ANY(version_ids);
 RETURN jsonb_build_object('compositionVersion','publication-context/1','kind',o.kind,'resource',resource,'activeReleaseId',active.id,'configuration',active.configuration,'agents',profiles,
   'supportProfile',(SELECT support_profile FROM crm.tenant_settings WHERE tenant_id=o.tenant_id),
   'canonicalSources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'definition',v.definition,'agentVersionId',v.agent_profile_version_id) ORDER BY v.id)
      FROM automation.flow_versions v JOIN automation.tenant_processes p ON p.tenant_id=v.tenant_id AND p.flow_version_id=v.id WHERE v.tenant_id=o.tenant_id AND p.enabled),'[]'),
   'retainedSources',coalesce((SELECT jsonb_agg(jsonb_build_object('flowId',f.flow_id,'version',f.version,'spec',f.spec) ORDER BY f.flow_id,f.version) FROM public.flows f WHERE f.tenant_id=o.tenant_id AND EXISTS(SELECT 1 FROM automation.flow_versions v JOIN automation.tenant_processes p ON p.tenant_id=v.tenant_id AND p.flow_version_id=v.id CROSS JOIN LATERAL jsonb_array_elements(v.definition->'nodes') n WHERE v.tenant_id=o.tenant_id AND p.enabled AND n->>'type'='voice.call' AND n#>>'{configuration,flowId}'=f.flow_id::text AND n#>>'{configuration,flowVersion}'=f.version::text)),'[]'));
END $$;
CREATE FUNCTION platform.prepare_publication_evaluation(p_operation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE snapshot jsonb; digest text; previous text; BEGIN
 PERFORM platform.quality_manager();
 snapshot:=platform.publication_candidate_snapshot(p_operation);digest:=platform.quality_hash(snapshot);
 SELECT candidate_digest INTO previous FROM automation.publication_operations WHERE tenant_id=platform.current_tenant_id() AND id=p_operation FOR UPDATE;
 IF previous IS NOT NULL AND previous<>digest THEN RAISE EXCEPTION 'publication candidate changed; create a new request' USING ERRCODE='40001';END IF;
 UPDATE automation.publication_operations SET candidate_snapshot=snapshot,candidate_digest=digest WHERE tenant_id=platform.current_tenant_id() AND id=p_operation;
 RETURN jsonb_build_object('digest',digest,'agents',snapshot->'agents');
END $$;
CREATE FUNCTION platform.request_publication_quality_evaluation(p_operation uuid,p_version uuid,p_dataset uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prepared jsonb; base_job uuid; result uuid; BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tenant-configuration:'||platform.current_tenant_id()::text,0));
 prepared:=platform.prepare_publication_evaluation(p_operation);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prepared->'agents') a WHERE a->>'agentVersionId'=p_version::text) THEN RAISE EXCEPTION 'agent not part of candidate' USING ERRCODE='42501';END IF;
 SELECT j.id INTO result FROM agents.quality_evaluation_jobs j JOIN agents.publication_evaluation_contexts c ON c.job_id=j.id WHERE j.tenant_id=platform.current_tenant_id() AND c.operation_id=p_operation AND c.candidate_digest=prepared->>'digest' AND j.version_id=p_version AND j.dataset_id=p_dataset AND j.expires_at>clock_timestamp() AND j.state IN ('blocked','pending','running','passed');
 IF result IS NOT NULL THEN RETURN result;END IF;
 base_job:=platform.request_agent_quality_evaluation(p_version,p_dataset,'publication');
 IF NOT EXISTS(SELECT 1 FROM agents.publication_evaluation_contexts WHERE job_id=base_job) AND EXISTS(SELECT 1 FROM agents.quality_evaluation_jobs WHERE id=base_job AND state IN ('pending','blocked')) THEN result:=base_job;
 ELSE
 IF (SELECT count(*) FROM agents.quality_evaluation_jobs WHERE tenant_id=platform.current_tenant_id() AND state IN ('pending','running','blocked') AND expires_at>clock_timestamp())>=100 THEN RAISE EXCEPTION 'bounded quality backlog full' USING ERRCODE='54000';END IF;
 INSERT INTO agents.quality_evaluation_jobs(tenant_id,agent_id,version_id,dataset_id,snapshot_digest,dataset_digest,trigger,requested_by,state)
 SELECT tenant_id,agent_id,version_id,dataset_id,snapshot_digest,dataset_digest,'publication',platform.current_user_id(),CASE WHEN state='blocked' THEN 'blocked' ELSE 'pending' END FROM agents.quality_evaluation_jobs WHERE id=base_job RETURNING id INTO result;
 END IF;
 INSERT INTO agents.publication_evaluation_contexts(tenant_id,job_id,operation_id,candidate_digest)VALUES(platform.current_tenant_id(),result,p_operation,prepared->>'digest');
 RETURN result;
END $$;
ALTER FUNCTION platform.claim_agent_quality_evaluation() RENAME TO claim_agent_quality_evaluation_unscoped;
REVOKE ALL ON FUNCTION platform.claim_agent_quality_evaluation_unscoped() FROM platform_agent_evaluation;
CREATE FUNCTION platform.claim_agent_quality_evaluation() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; context agents.publication_evaluation_contexts; snapshot jsonb; BEGIN
 result:=platform.claim_agent_quality_evaluation_unscoped();
 IF result IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO context FROM agents.publication_evaluation_contexts WHERE job_id=(result->>'jobId')::uuid;
 IF context.job_id IS NOT NULL THEN
   SELECT candidate_snapshot INTO snapshot FROM automation.publication_operations WHERE tenant_id=context.tenant_id AND id=context.operation_id;
   result:=result||jsonb_build_object('publicationOperationId',context.operation_id,'publicationCandidateDigest',context.candidate_digest,'publicationCandidate',snapshot);
 END IF;
 RETURN result;
END $$;
ALTER FUNCTION platform.append_agent_quality_case(uuid,uuid,uuid,jsonb) RENAME TO append_agent_quality_case_unscoped;
REVOKE ALL ON FUNCTION platform.append_agent_quality_case_unscoped(uuid,uuid,uuid,jsonb) FROM platform_agent_evaluation;
CREATE FUNCTION platform.append_agent_quality_case(p_job uuid,p_token uuid,p_case uuid,p_record jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE digest text;BEGIN
 SELECT candidate_digest INTO digest FROM agents.publication_evaluation_contexts WHERE job_id=p_job;
 IF digest IS NOT NULL AND p_record->>'publicationCandidateDigest' IS DISTINCT FROM digest THEN RAISE EXCEPTION 'physical case must attest exact publication candidate' USING ERRCODE='55000';END IF;
 PERFORM platform.append_agent_quality_case_unscoped(p_job,p_token,p_case,p_record);
END $$;
ALTER FUNCTION platform.finalize_agent_quality_evaluation(uuid,uuid) RENAME TO finalize_agent_quality_evaluation_unscoped;
REVOKE ALL ON FUNCTION platform.finalize_agent_quality_evaluation_unscoped(uuid,uuid) FROM platform_agent_evaluation;
CREATE FUNCTION platform.finalize_agent_quality_evaluation(p_job uuid,p_token uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE context agents.publication_evaluation_contexts; old_tenant text; receipt uuid; BEGIN
 SELECT * INTO context FROM agents.publication_evaluation_contexts WHERE job_id=p_job;
 IF context.job_id IS NOT NULL THEN
   old_tenant:=current_setting('app.current_tenant',true);PERFORM set_config('app.current_tenant',context.tenant_id::text,true);
   IF platform.quality_hash(platform.publication_candidate_snapshot(context.operation_id))<>context.candidate_digest THEN RAISE EXCEPTION 'publication evaluation candidate stale' USING ERRCODE='55000';END IF;
   PERFORM set_config('app.current_tenant',coalesce(old_tenant,''),true);
 END IF;
 receipt:=platform.finalize_agent_quality_evaluation_unscoped(p_job,p_token);RETURN receipt;
END $$;
CREATE FUNCTION platform.publication_evaluation_satisfied(p_operation uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prepared jsonb; entry jsonb; BEGIN
 PERFORM platform.quality_manager();
 IF NOT platform.current_agent_quality_gate_enabled() THEN RETURN true;END IF;
 prepared:=platform.prepare_publication_evaluation(p_operation);
 FOR entry IN SELECT value FROM jsonb_array_elements(prepared->'agents') LOOP
   IF NOT EXISTS(SELECT 1 FROM agents.publication_evaluation_contexts c JOIN agents.quality_evaluation_jobs j ON j.id=c.job_id JOIN agents.quality_evaluation_receipts r ON r.job_id=j.id
     WHERE c.tenant_id=platform.current_tenant_id() AND c.operation_id=p_operation AND c.candidate_digest=prepared->>'digest' AND j.version_id=(entry->>'agentVersionId')::uuid AND j.state='passed' AND r.expires_at>clock_timestamp() AND r.snapshot_digest=entry->>'snapshot'
     AND platform.quality_policy_current(j.dataset_id) AND platform.quality_knowledge_current(j.tenant_id,j.version_id) AND EXISTS(SELECT 1 FROM agents.quality_dataset_approvals a WHERE a.tenant_id=j.tenant_id AND a.dataset_id=j.dataset_id AND a.revoked_at IS NULL)) THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE FUNCTION platform.list_publication_quality_evaluations(p_operation uuid,p_version uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE results jsonb;BEGIN
 PERFORM platform.quality_manager();
 results:=platform.list_agent_quality_evaluations(p_version);
 RETURN coalesce((SELECT jsonb_agg(item) FROM jsonb_array_elements(results) item WHERE EXISTS(SELECT 1 FROM agents.publication_evaluation_contexts c WHERE c.tenant_id=platform.current_tenant_id() AND c.operation_id=p_operation AND c.job_id::text=item->>'id')),'[]');
END $$;
CREATE FUNCTION platform.guard_publication_activation_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE operation uuid; BEGIN
 IF NEW.status='published' AND OLD.status IS DISTINCT FROM 'published' THEN
  SELECT id INTO operation FROM automation.publication_operations WHERE tenant_id=NEW.tenant_id AND result->>'releaseId'=NEW.id::text AND candidate_digest IS NOT NULL;
  IF operation IS NOT NULL AND NOT platform.publication_evaluation_satisfied(operation) THEN RAISE EXCEPTION 'exact publication candidate evaluation required before activation' USING ERRCODE='55000';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER publication_activation_evidence BEFORE UPDATE OF status ON platform.tenant_configuration_releases FOR EACH ROW EXECUTE FUNCTION platform.guard_publication_activation_evidence();
REVOKE ALL ON FUNCTION platform.list_publication_quality_evaluations(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.list_publication_quality_evaluations(uuid,uuid) TO platform_web;
REVOKE ALL ON FUNCTION platform.publication_candidate_snapshot(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.prepare_publication_evaluation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.request_publication_quality_evaluation(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.publication_evaluation_satisfied(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.prepare_publication_evaluation(uuid),platform.request_publication_quality_evaluation(uuid,uuid,uuid),platform.publication_evaluation_satisfied(uuid) TO platform_web;
REVOKE ALL ON FUNCTION platform.claim_agent_quality_evaluation(),platform.append_agent_quality_case(uuid,uuid,uuid,jsonb),platform.finalize_agent_quality_evaluation(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.claim_agent_quality_evaluation(),platform.append_agent_quality_case(uuid,uuid,uuid,jsonb),platform.finalize_agent_quality_evaluation(uuid,uuid) TO platform_agent_evaluation;
"""


def upgrade() -> None:
    _execute(SQL)


def downgrade() -> None:
    # Candidate attestation is release evidence; no silent destruction after use.
    _execute("""
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM agents.publication_evaluation_contexts) THEN RAISE EXCEPTION 'archive publication evaluation evidence before downgrade';END IF;END $$;
    DROP TRIGGER publication_activation_evidence ON platform.tenant_configuration_releases;
    DROP FUNCTION platform.guard_publication_activation_evidence();
    DROP FUNCTION platform.list_publication_quality_evaluations(uuid,uuid);
    DROP FUNCTION platform.publication_evaluation_satisfied(uuid);
    DROP FUNCTION platform.request_publication_quality_evaluation(uuid,uuid,uuid);
    DROP FUNCTION platform.prepare_publication_evaluation(uuid);
    DROP FUNCTION platform.publication_candidate_snapshot(uuid);
    DROP FUNCTION platform.claim_agent_quality_evaluation();
    DROP FUNCTION platform.append_agent_quality_case(uuid,uuid,uuid,jsonb);
    DROP FUNCTION platform.finalize_agent_quality_evaluation(uuid,uuid);
    ALTER FUNCTION platform.claim_agent_quality_evaluation_unscoped() RENAME TO claim_agent_quality_evaluation;
    ALTER FUNCTION platform.append_agent_quality_case_unscoped(uuid,uuid,uuid,jsonb) RENAME TO append_agent_quality_case;
    ALTER FUNCTION platform.finalize_agent_quality_evaluation_unscoped(uuid,uuid) RENAME TO finalize_agent_quality_evaluation;
    GRANT EXECUTE ON FUNCTION platform.claim_agent_quality_evaluation(),platform.append_agent_quality_case(uuid,uuid,uuid,jsonb),platform.finalize_agent_quality_evaluation(uuid,uuid) TO platform_agent_evaluation;
    DROP TABLE agents.publication_evaluation_contexts;
    ALTER TABLE automation.publication_operations DROP COLUMN candidate_snapshot,DROP COLUMN candidate_digest;
    """)
