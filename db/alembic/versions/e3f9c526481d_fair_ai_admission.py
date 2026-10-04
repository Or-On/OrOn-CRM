"""Durable flagged AI admission, preserving legacy fenced claim semantics.

Revision ID: e3f9c526481d
Revises: e2f8b415370c
"""

from alembic import op

revision = "e3f9c526481d"
down_revision = "e2f8b415370c"
branch_labels = None
depends_on = None


def _execute_statements(script: str) -> None:
    """Submit this fixed migration's dollar-quoted DDL one statement at a time.

    asyncpg prepares one statement per execute. These constants contain no
    semicolons in SQL string literals; function-body semicolons stay intact.
    """
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


LEGACY_CLAIM = """
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


def upgrade() -> None:
    op.execute("""
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
""")
    _execute_statements("""

CREATE TABLE ops.reply_admission_state (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  last_admitted_at timestamptz NOT NULL
);
ALTER TABLE ops.reply_admission_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.reply_admission_state FORCE ROW LEVEL SECURITY;
CREATE POLICY reply_admission_tenant ON ops.reply_admission_state
  USING (tenant_id=platform.current_tenant_id());
REVOKE ALL ON ops.reply_admission_state FROM PUBLIC;
CREATE FUNCTION ops.claim_fair_ai_reply(p_worker_id text)
RETURNS SETOF ops.jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE chosen uuid; chosen_tenant uuid;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'valid worker identifier required' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(734921,441);
  WITH invalid AS (
    SELECT j.id FROM ops.jobs j
    JOIN platform.tenant_remediation_flags f ON f.tenant_id=j.tenant_id
      AND f.flag_key='queue_priority' AND f.enabled
    WHERE j.queue='messaging' AND j.job_type='whatsapp.ai.reply'
      AND j.status IN ('queued','retry') AND j.available_at<=clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM messaging.conversations c
        WHERE c.tenant_id=j.tenant_id AND c.id=j.reference_id
          AND j.reference_type='conversation'
          AND j.payload->>'conversationId'=c.id::text)
    ORDER BY j.available_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 100
  ), terminal AS (
    UPDATE ops.jobs j SET status='dead',completed_at=clock_timestamp(),
      last_error_safe='ai_admission_context_invalid',updated_at=clock_timestamp()
    FROM invalid WHERE j.id=invalid.id RETURNING j.*
  ) INSERT INTO audit.records(
    tenant_id,actor_service,action,target_type,target_id,metadata)
    SELECT tenant_id,'messaging-worker','job.admission_invalid','job',id,
      jsonb_build_object('jobType',job_type,'reason','ai_admission_context_invalid')
    FROM terminal;
  IF (SELECT count(*) FROM ops.jobs j WHERE j.queue='messaging'
    AND j.job_type='whatsapp.ai.reply' AND j.status='running'
    AND coalesce(j.lease_expires_at,j.locked_at+interval '120 seconds')>
      clock_timestamp())>=4 THEN RETURN; END IF;
  SELECT j.id,j.tenant_id INTO chosen,chosen_tenant
  FROM ops.jobs j
  JOIN platform.tenant_remediation_flags f ON f.tenant_id=j.tenant_id
    AND f.flag_key='queue_priority' AND f.enabled
  JOIN messaging.conversations c ON c.id=j.reference_id
    AND c.tenant_id=j.tenant_id AND j.reference_type='conversation'
    AND j.payload->>'conversationId'=c.id::text
  LEFT JOIN ops.reply_admission_state state ON state.tenant_id=j.tenant_id
  WHERE j.queue='messaging' AND j.job_type='whatsapp.ai.reply'
    AND j.attempts<j.max_attempts
    AND ((j.status IN ('queued','retry') AND j.available_at<=clock_timestamp())
      OR (j.status='running' AND
        coalesce(j.lease_expires_at,j.locked_at+interval '120 seconds')<
          clock_timestamp()))
    AND (SELECT count(*) FROM ops.jobs active WHERE active.queue='messaging'
      AND active.job_type='whatsapp.ai.reply' AND active.status='running'
      AND active.tenant_id=j.tenant_id
      AND coalesce(active.lease_expires_at,active.locked_at+interval '120 seconds')>
        clock_timestamp())<2
    AND NOT EXISTS (SELECT 1 FROM ops.jobs active
      WHERE active.queue='messaging' AND active.job_type='whatsapp.ai.reply'
        AND active.status='running' AND active.tenant_id=j.tenant_id
        AND active.reference_type='conversation' AND active.reference_id=c.id
        AND coalesce(active.lease_expires_at,active.locked_at+interval '120 seconds')>
          clock_timestamp())
  ORDER BY state.last_admitted_at NULLS FIRST,j.priority DESC,j.available_at,j.id
  FOR UPDATE OF j SKIP LOCKED LIMIT 1;
  IF chosen IS NULL THEN RETURN; END IF;
  INSERT INTO ops.reply_admission_state(tenant_id,last_admitted_at)
    VALUES(chosen_tenant,clock_timestamp())
    ON CONFLICT(tenant_id) DO UPDATE SET last_admitted_at=EXCLUDED.last_admitted_at;
  RETURN QUERY UPDATE ops.jobs j SET status='running',attempts=j.attempts+1,
    claim_token=gen_random_uuid(),locked_at=clock_timestamp(),locked_by=p_worker_id,
    lease_expires_at=clock_timestamp()+interval '120 seconds',
    updated_at=clock_timestamp() WHERE j.id=chosen RETURNING j.*;
END $$;
REVOKE ALL ON FUNCTION ops.claim_fair_ai_reply(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.claim_fair_ai_reply(text) TO platform_messaging;

""")


def downgrade() -> None:
    op.execute("DROP FUNCTION ops.claim_fair_ai_reply(text)")
    op.execute("DROP TABLE ops.reply_admission_state")
    op.execute(LEGACY_CLAIM)
