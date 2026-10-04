"""Fresh summary-only model routing and shared daily quota accounting."""

from alembic import op
from sqlalchemy.schema import DDL

revision = "f5fd1748ca3f"
down_revision = "f4ec0637b92e"
branch_labels = None
depends_on = None
SQL = r"""
CREATE TABLE agents.memory_summary_attempts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 job_id uuid NOT NULL REFERENCES ops.jobs(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL REFERENCES agents.memory_summary_requests(id) ON DELETE RESTRICT,
 model_configuration_id uuid NOT NULL REFERENCES agents.model_configurations(id) ON DELETE
 RESTRICT,
 claim_token uuid NOT NULL,
 model_snapshot jsonb NOT NULL,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','complete','failed')),
 input_tokens integer CHECK(input_tokens>=0),output_tokens integer CHECK(output_tokens>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 UNIQUE(job_id,claim_token));
ALTER TABLE agents.memory_summary_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.memory_summary_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY deny_direct_summary_attempts ON agents.memory_summary_attempts USING(false);
CREATE FUNCTION platform.memory_summary_model_projection(p_job uuid,p_worker text,p_claim uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE work jsonb; projection jsonb;
BEGIN
 work:=platform.load_memory_summary_job(p_job,p_worker,p_claim);
 SELECT jsonb_build_object('configurationId',m.id,'provider',m.provider,'model',m.model,
 'settings',m.settings,'dailyRequestLimit',m.daily_request_limit,'credential',jsonb_build_object(
 'tenantId',m.tenant_id,'modelConfigurationId',m.id,'credentialId',cr.id,'provider',m.provider,
 'kind',cr.kind,'algorithm',cr.algorithm,'keyVersion',cr.key_version,
 'ciphertext',encode(cr.ciphertext,'hex'),'nonce',encode(cr.nonce,'hex')))
 INTO projection FROM agents.memory_summary_requests r
 JOIN agents.agent_profile_versions a ON a.tenant_id=r.tenant_id AND a.id=r.agent_version_id
 JOIN agents.agent_profiles profile ON profile.tenant_id=a.tenant_id AND
 profile.id=a.agent_profile_id
 JOIN agents.model_configurations m ON m.tenant_id=a.tenant_id AND m.id=a.model_configuration_id
 JOIN platform.credential_records cr ON cr.tenant_id=m.tenant_id AND cr.id=m.credential_id
 WHERE r.id=(work->>'requestId')::uuid AND r.tenant_id=platform.current_tenant_id()
 AND a.published_at IS NOT NULL AND a.validation_status='valid' AND profile.archived_at IS NULL
 AND m.is_enabled AND m.provider IN('openai','gemini')
 AND m.daily_request_limit BETWEEN 1 AND 100000
 AND cr.kind='llm_api_key_v2' AND cr.algorithm='aes-256-gcm:model-provider:v2'
 AND cr.key_version IS NOT NULL AND cr.key_version<>'env:v1'
 AND octet_length(cr.ciphertext) BETWEEN 17 AND 10000 AND octet_length(cr.nonce)=12
 FOR SHARE OF a,profile,m,cr;
 IF projection IS NULL THEN RAISE EXCEPTION 'summary model unavailable' USING ERRCODE='42501';
 END IF;
 RETURN projection;
END $$;
CREATE FUNCTION platform.reserve_memory_summary_attempt(p_job uuid,p_worker text,p_claim
 uuid,p_expected jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE projection jsonb; attempt uuid; inserted bigint; quota integer; configuration uuid;
BEGIN
 projection:=platform.memory_summary_model_projection(p_job,p_worker,p_claim);
 IF projection IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'summary model changed' USING
 ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM agents.memory_summary_attempts WHERE job_id=p_job AND
 claim_token=p_claim)
 THEN RAISE EXCEPTION 'summary attempt already reserved' USING ERRCODE='42501'; END IF;
 configuration:=(projection->>'configurationId')::uuid;
 quota:=(projection->>'dailyRequestLimit')::integer;
 IF quota IS NOT NULL THEN
 INSERT INTO agents.model_daily_reservations AS
 counter(tenant_id,model_configuration_id,utc_day,reserved_attempts)
 VALUES(platform.current_tenant_id(),configuration,(clock_timestamp() AT TIME ZONE 'UTC')::date,1)
 ON CONFLICT(tenant_id,model_configuration_id,utc_day) DO UPDATE SET
 reserved_attempts=counter.reserved_attempts+1,
 updated_at=clock_timestamp() WHERE counter.reserved_attempts<quota RETURNING
 reserved_attempts INTO inserted;
 IF inserted IS NULL THEN RAISE EXCEPTION 'summary quota exhausted' USING ERRCODE='42501'; END IF;
 END IF;
 -- Counter contention can outlive a lease or source grant. Any failure rolls back reservation.
 IF platform.memory_summary_model_projection(p_job,p_worker,p_claim) IS DISTINCT FROM projection
 THEN RAISE EXCEPTION 'summary authority changed' USING ERRCODE='42501'; END IF;
 INSERT INTO
 agents.memory_summary_attempts(tenant_id,job_id,request_id,model_configuration_id,claim_token,model_snapshot)
 SELECT
 platform.current_tenant_id(),p_job,(platform.load_memory_summary_job(p_job,p_worker,p_claim)->>'requestId')::uuid,configuration,p_claim,projection
 RETURNING id INTO attempt;
 RETURN attempt;
END $$;
CREATE FUNCTION platform.settle_memory_summary_attempt(p_job uuid,p_worker text,p_claim
 uuid,p_attempt uuid,
 p_success boolean,p_input integer,p_output integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM agents.memory_summary_attempts
 WHERE tenant_id=platform.current_tenant_id() AND id=p_attempt AND job_id=p_job
 AND claim_token=p_claim AND state='reserved'
 AND model_snapshot=platform.memory_summary_model_projection(p_job,p_worker,p_claim)) THEN
 RAISE EXCEPTION 'summary model authority changed' USING ERRCODE='42501'; END IF;
 UPDATE agents.memory_summary_attempts SET state=CASE WHEN p_success THEN 'complete' ELSE
 'failed' END,
 input_tokens=p_input,output_tokens=p_output,completed_at=clock_timestamp()
 WHERE tenant_id=platform.current_tenant_id() AND id=p_attempt AND job_id=p_job AND
 claim_token=p_claim AND state='reserved';
 IF NOT FOUND THEN RAISE EXCEPTION 'summary accounting authority unavailable' USING
 ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION platform.memory_summary_model_projection(uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.reserve_memory_summary_attempt(uuid,text,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION
 platform.settle_memory_summary_attempt(uuid,text,uuid,uuid,boolean,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.memory_summary_model_projection(uuid,text,uuid),
 platform.reserve_memory_summary_attempt(uuid,text,uuid,jsonb),
 platform.settle_memory_summary_attempt(uuid,text,uuid,uuid,boolean,integer,integer) TO
 platform_messaging;
"""
PREVIOUS_CLAIM = r"""
CREATE OR REPLACE FUNCTION ops.claim_jobs_all_tenants(
        p_worker_id text,p_queue text,p_limit integer DEFAULT 10,p_lease_seconds integer DEFAULT
        300)
      RETURNS SETOF ops.jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN
        IF p_queue NOT IN ('messaging','field_service') THEN RETURN; END IF;
        WITH exhausted AS (
          SELECT id FROM ops.jobs WHERE queue=p_queue AND tenant_id IS NOT NULL
            AND (p_queue='messaging' OR job_type LIKE 'field_service.%')
            AND status='running' AND attempts>=max_attempts
            AND
           
 COALESCE(lease_expires_at,locked_at+make_interval(secs=>GREATEST(1,p_lease_seconds)))<clock_timestamp()
          FOR UPDATE SKIP LOCKED
        ), terminal AS (
          UPDATE ops.jobs job SET status='dead',completed_at=clock_timestamp(),
            locked_at=NULL,locked_by=NULL,lease_expires_at=NULL,
            last_error_safe='job_lease_exhausted',updated_at=clock_timestamp()
          FROM exhausted WHERE job.id=exhausted.id RETURNING job.*
        ) INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
          SELECT tenant_id,'messaging-worker','job.lease_exhausted','job',id,
            jsonb_build_object('jobType',job_type,'queue',queue) FROM terminal;
        RETURN QUERY WITH candidates AS (
          SELECT id FROM ops.jobs WHERE queue=p_queue AND tenant_id IS NOT NULL
            AND (p_queue='messaging' OR job_type LIKE 'field_service.%') AND attempts<max_attempts
            AND NOT (job_type='whatsapp.ai.reply' AND EXISTS (
                SELECT 1 FROM platform.tenant_remediation_flags f
                WHERE f.tenant_id=ops.jobs.tenant_id
                  AND f.flag_key='queue_priority' AND f.enabled))
            AND ((status IN ('queued','retry') AND available_at<=clock_timestamp()) OR
              (status='running' AND
             
 COALESCE(lease_expires_at,locked_at+make_interval(secs=>GREATEST(1,p_lease_seconds)))<clock_timestamp()))
          ORDER BY priority DESC,available_at,id FOR UPDATE SKIP LOCKED
          LIMIT LEAST(GREATEST(p_limit,1),100)
        ) UPDATE ops.jobs job SET status='running',attempts=job.attempts+1,
          claim_token=gen_random_uuid(),locked_at=clock_timestamp(),locked_by=p_worker_id,
         
 lease_expires_at=clock_timestamp()+make_interval(secs=>LEAST(GREATEST(p_lease_seconds,1),300)),
          updated_at=clock_timestamp() FROM candidates WHERE job.id=candidates.id RETURNING job.*;
      END $$;
"""
BACKGROUND_SQL = r"""
CREATE OR REPLACE FUNCTION ops.claim_jobs_all_tenants(
        p_worker_id text,p_queue text,p_limit integer DEFAULT 10,p_lease_seconds integer DEFAULT
        300)
      RETURNS SETOF ops.jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN
        IF p_queue NOT IN ('messaging','field_service') THEN RETURN; END IF;
        WITH exhausted AS (
          SELECT id FROM ops.jobs WHERE queue=p_queue AND tenant_id IS NOT NULL
            AND (p_queue='messaging' OR job_type LIKE 'field_service.%')
            AND status='running' AND attempts>=max_attempts
            AND
           
 COALESCE(lease_expires_at,locked_at+make_interval(secs=>GREATEST(1,p_lease_seconds)))<clock_timestamp()
          FOR UPDATE SKIP LOCKED
        ), terminal AS (
          UPDATE ops.jobs job SET status='dead',completed_at=clock_timestamp(),
            locked_at=NULL,locked_by=NULL,lease_expires_at=NULL,
            last_error_safe='job_lease_exhausted',updated_at=clock_timestamp()
          FROM exhausted WHERE job.id=exhausted.id RETURNING job.*
        ) INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
          SELECT tenant_id,'messaging-worker','job.lease_exhausted','job',id,
            jsonb_build_object('jobType',job_type,'queue',queue) FROM terminal;
        RETURN QUERY WITH candidates AS (
          SELECT id FROM ops.jobs WHERE queue=p_queue AND tenant_id IS NOT NULL
            AND (p_queue='messaging' OR job_type LIKE 'field_service.%') AND
 attempts<max_attempts AND job_type<>'memory.summary'
            AND NOT (job_type='whatsapp.ai.reply' AND EXISTS (
                SELECT 1 FROM platform.tenant_remediation_flags f
                WHERE f.tenant_id=ops.jobs.tenant_id
                  AND f.flag_key='queue_priority' AND f.enabled))
            AND ((status IN ('queued','retry') AND available_at<=clock_timestamp()) OR
              (status='running' AND
             
 COALESCE(lease_expires_at,locked_at+make_interval(secs=>GREATEST(1,p_lease_seconds)))<clock_timestamp()))
          ORDER BY priority DESC,available_at,id FOR UPDATE SKIP LOCKED
          LIMIT LEAST(GREATEST(p_limit,1),100)
        ) UPDATE ops.jobs job SET status='running',attempts=job.attempts+1,
          claim_token=gen_random_uuid(),locked_at=clock_timestamp(),locked_by=p_worker_id,
         
 lease_expires_at=clock_timestamp()+make_interval(secs=>LEAST(GREATEST(p_lease_seconds,1),300)),
          updated_at=clock_timestamp() FROM candidates WHERE job.id=candidates.id RETURNING job.*;
      END $$;

CREATE FUNCTION ops.claim_memory_summary(p_worker text)
RETURNS SETOF ops.jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected uuid;
BEGIN
 IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 200 THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(734921,442);
 IF (SELECT count(*) FROM ops.jobs WHERE queue='messaging' AND job_type='memory.summary'
 AND status='running' AND lease_expires_at>clock_timestamp())>=2 THEN RETURN; END IF;
 SELECT j.id INTO selected FROM ops.jobs j WHERE j.queue='messaging' AND
 j.job_type='memory.summary'
 AND j.tenant_id IS NOT NULL AND j.attempts<j.max_attempts
 AND ((j.status IN('queued','retry') AND j.available_at<=clock_timestamp()) OR
 (j.status='running' AND coalesce(j.lease_expires_at,j.locked_at+interval
 '120 seconds')<clock_timestamp()))
 AND NOT EXISTS(SELECT 1 FROM ops.jobs live WHERE live.tenant_id=j.tenant_id AND
 live.queue='messaging' AND live.job_type='memory.summary' AND live.status='running'
 AND live.lease_expires_at>clock_timestamp())
 ORDER BY (SELECT max(previous.locked_at) FROM ops.jobs previous WHERE
 previous.tenant_id=j.tenant_id
 AND previous.job_type='memory.summary') NULLS FIRST,j.available_at,j.id
 FOR UPDATE OF j SKIP LOCKED LIMIT 1;
 IF selected IS NULL THEN RETURN; END IF;
 RETURN QUERY UPDATE ops.jobs SET
 status='running',attempts=attempts+1,claim_token=gen_random_uuid(),
 locked_at=clock_timestamp(),locked_by=p_worker,lease_expires_at=clock_timestamp()+interval
 '120 seconds',
 updated_at=clock_timestamp() WHERE id=selected RETURNING *;
END $$;
REVOKE ALL ON FUNCTION ops.claim_memory_summary(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.claim_memory_summary(text) TO platform_messaging;
"""


def execute_statements(script):
    pending = ""
    for index, part in enumerate(script.split("$$")):
        if index % 2:
            pending += "$$" + part + "$$"
            continue
        pieces = part.split(";")
        pending += pieces[0]
        for piece in pieces[1:]:
            if pending.strip():
                op.execute(DDL(pending.replace("%", "%%")))
            pending = piece
    if pending.strip():
        op.execute(DDL(pending.replace("%", "%%")))


def upgrade():
    expected_body = PREVIOUS_CLAIM.split("$$")[1]
    guard = (
        "DO $guard$ BEGIN IF (SELECT regexp_replace(prosrc,'[[:space:]]+',' ','g') "  # noqa: S608 -- static migration body
        "FROM pg_proc WHERE oid="
        "'ops.claim_jobs_all_tenants(text,text,integer,integer)'::regprocedure) "
        "IS DISTINCT FROM regexp_replace($original$"
        + expected_body
        + "$original$,'[[:space:]]+',' ','g') THEN "
        "RAISE EXCEPTION 'summary migration claim contract drift'; END IF; END $guard$"
    )
    op.execute(DDL(guard.replace("%", "%%")))
    execute_statements(SQL)
    execute_statements(BACKGROUND_SQL)


def downgrade():
    op.execute(
        "DO $$ BEGIN IF EXISTS(SELECT 1 FROM agents.memory_summary_attempts) THEN RAISE "
        "EXCEPTION 'summary accounting evidence retained'; END IF; END $$"
    )
    op.execute(
        "DROP FUNCTION platform.settle_memory_summary_attempt(uuid,text,uuid,uuid,boolean"
        ",integer,integer)"
    )
    op.execute("DROP FUNCTION platform.reserve_memory_summary_attempt(uuid,text,uuid,jsonb)")
    op.execute("DROP FUNCTION platform.memory_summary_model_projection(uuid,text,uuid)")
    op.execute("DROP TABLE agents.memory_summary_attempts")
    op.execute("DROP FUNCTION ops.claim_memory_summary(text)")
    execute_statements(PREVIOUS_CLAIM)
