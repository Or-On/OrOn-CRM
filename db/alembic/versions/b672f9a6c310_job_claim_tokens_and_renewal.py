"""Fence each messaging/field-service job claim and renew owned leases.

Revision ID: b672f9a6c310
Revises: a14d0c8e2b77
"""

from alembic import op

revision = "b672f9a6c310"
down_revision = "a14d0c8e2b77"
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


def upgrade() -> None:
    op.execute(
        "ALTER TABLE ops.jobs ADD COLUMN claim_token uuid, ADD COLUMN lease_expires_at timestamptz"
    )
    _execute_statements("""
      REVOKE EXECUTE ON FUNCTION ops.claim_jobs(text,text,integer,integer)
        FROM platform_messaging;
      REVOKE EXECUTE ON FUNCTION ops.fail_job(uuid,text,text,integer)
        FROM platform_messaging;
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
      CREATE FUNCTION ops.renew_messaging_job_claim(p_job_id uuid,p_worker_id text,p_token uuid)
      RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
        WITH renewed AS (UPDATE ops.jobs SET lease_expires_at=clock_timestamp()+interval
        '120 seconds',updated_at=clock_timestamp()
          WHERE id=p_job_id AND tenant_id=platform.current_tenant_id() AND status='running'
            AND locked_by=p_worker_id AND claim_token=p_token AND
            lease_expires_at>clock_timestamp()
            AND (queue='messaging' OR (queue='field_service' AND job_type LIKE
            'field_service.%')) RETURNING id)
        SELECT EXISTS(SELECT 1 FROM renewed)
      $$;
      REVOKE ALL ON FUNCTION ops.renew_messaging_job_claim(uuid,text,uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION ops.renew_messaging_job_claim(uuid,text,uuid) TO
      platform_messaging;
      CREATE FUNCTION ops.fail_messaging_job_claim(p_job_id uuid,p_worker_id text,p_token
      uuid,p_error_safe text,p_retry_delay_seconds integer)
      RETURNS ops.jobs LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
        UPDATE ops.jobs job SET status=CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'retry'
        END,
          available_at=CASE WHEN attempts>=max_attempts THEN available_at ELSE
          clock_timestamp()+make_interval(secs=>LEAST(86400.0,
            GREATEST(p_retry_delay_seconds,1)*power(2.0,LEAST(GREATEST(attempts-1,0),16))
            +random()*GREATEST(p_retry_delay_seconds,1))) END,
          completed_at=CASE WHEN attempts>=max_attempts THEN clock_timestamp() ELSE NULL END,
          locked_at=NULL,locked_by=NULL,lease_expires_at=NULL,last_error_safe=left(p_error_safe,2000),updated_at=clock_timestamp()
        WHERE id=p_job_id AND tenant_id=platform.current_tenant_id() AND status='running'
          AND locked_by=p_worker_id AND claim_token=p_token AND lease_expires_at>clock_timestamp()
          AND (queue='messaging' OR (queue='field_service' AND job_type LIKE 'field_service.%'))
          RETURNING job.*
      $$;
      REVOKE ALL ON FUNCTION ops.fail_messaging_job_claim(uuid,text,uuid,text,integer) FROM
      PUBLIC;
      GRANT EXECUTE ON FUNCTION ops.fail_messaging_job_claim(uuid,text,uuid,text,integer) TO
      platform_messaging;
    """)


def downgrade() -> None:
    # Coordinated rollback requires stopped workers; restore only this claim
    # function, without reverting unrelated inbound-media migrations.
    _execute_statements("""
      DROP FUNCTION ops.fail_messaging_job_claim(uuid,text,uuid,text,integer);
      DROP FUNCTION ops.renew_messaging_job_claim(uuid,text,uuid);
      GRANT EXECUTE ON FUNCTION ops.claim_jobs(text,text,integer,integer)
        TO platform_messaging;
      GRANT EXECUTE ON FUNCTION ops.fail_job(uuid,text,text,integer)
        TO platform_messaging;
      CREATE OR REPLACE FUNCTION ops.claim_jobs_all_tenants(p_worker_id text,p_queue text,p_limit
      integer DEFAULT 10,p_lease_seconds integer DEFAULT 300)
      RETURNS SETOF ops.jobs LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
        WITH candidates AS (SELECT id FROM ops.jobs WHERE queue=p_queue AND p_queue='messaging'
        AND tenant_id IS NOT NULL AND attempts<max_attempts
          AND ((status IN ('queued','retry') AND available_at<=CURRENT_TIMESTAMP) OR
          (status='running' AND
          locked_at<CURRENT_TIMESTAMP-make_interval(secs=>GREATEST(1,p_lease_seconds))))
          ORDER BY priority DESC,available_at,id FOR UPDATE SKIP LOCKED LIMIT
          LEAST(GREATEST(p_limit,1),100))
        UPDATE ops.jobs job SET
        status='running',attempts=attempts+1,locked_at=CURRENT_TIMESTAMP,
        locked_by=p_worker_id,updated_at=CURRENT_TIMESTAMP
        FROM candidates WHERE job.id=candidates.id RETURNING job.*
      $$;
      ALTER TABLE ops.jobs DROP COLUMN lease_expires_at,DROP COLUMN claim_token;
    """)
