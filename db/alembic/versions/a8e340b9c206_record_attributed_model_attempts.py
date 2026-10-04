"""Attribute every messaging model attempt without fabricating absent usage.

Revision ID: a8e340b9c206
Revises: f7d239a8b105
"""

from alembic import op

revision = "a8e340b9c206"
down_revision = "f7d239a8b105"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
      ALTER TABLE ops.jobs ADD COLUMN admitted_agent_version_id uuid
        REFERENCES agents.agent_profile_versions(id)
        ON DELETE RESTRICT
    """)
    op.execute("""
      ALTER TABLE agents.usage_events ADD COLUMN agent_version_id uuid
        REFERENCES agents.agent_profile_versions(id)
        ON DELETE RESTRICT,
        ADD COLUMN job_id uuid REFERENCES ops.jobs(id)
        ON DELETE RESTRICT,
        ADD COLUMN model text
    """)
    op.execute("""
      CREATE TABLE agents.model_attempts(
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES public.tenants(id)
        ON DELETE RESTRICT,
        job_id uuid NOT NULL REFERENCES ops.jobs(id)
        ON DELETE RESTRICT,
        agent_version_id uuid NOT NULL REFERENCES agents.agent_profile_versions(id)
        ON DELETE RESTRICT,
        model text NOT NULL CHECK(length(model) BETWEEN 1 AND 200),
        occurred_at timestamptz NOT NULL,
        latency_ms integer NOT NULL CHECK(latency_ms>=0),
        input_tokens bigint CHECK(input_tokens>=0),output_tokens bigint CHECK(output_tokens>=0),
        status text NOT NULL
          CHECK(status IN ('succeeded','http_error','timeout','invalid_response')),
        error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$')
      )
    """)
    op.execute("ALTER TABLE agents.model_attempts ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE agents.model_attempts FORCE ROW LEVEL SECURITY")
    op.execute("""
      CREATE POLICY model_attempts_isolation ON agents.model_attempts
      USING(tenant_id=platform.current_tenant_id())
      WITH CHECK(tenant_id=platform.current_tenant_id())
    """)
    op.execute("GRANT SELECT ON agents.model_attempts TO platform_web,platform_messaging")
    op.execute("""
      CREATE FUNCTION agents.record_messaging_model_attempt(
        p_id uuid,p_job uuid,p_agent uuid,p_model text,p_occurred timestamptz,p_latency integer,
        p_input bigint,p_output bigint,p_status text,p_error text)
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE inserted integer;
      BEGIN
        IF p_id IS NULL OR p_occurred IS NULL OR p_latency IS NULL OR p_latency<0
          OR p_model IS NULL OR length(p_model) NOT BETWEEN 1 AND 200
          OR p_status IS NULL
          OR p_status NOT IN ('succeeded','http_error','timeout','invalid_response')
          OR p_input<0 OR p_output<0
          OR (p_error IS NOT NULL AND p_error !~ '^[a-z0-9_]{1,80}$') THEN
          RAISE EXCEPTION 'invalid model attempt' USING ERRCODE='22023';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM ops.jobs j JOIN agents.agent_profile_versions a
          ON a.id=j.admitted_agent_version_id AND a.tenant_id=j.tenant_id
          WHERE j.id=p_job AND j.tenant_id=platform.current_tenant_id()
            AND j.queue='messaging' AND j.job_type='whatsapp.ai.reply' AND a.id=p_agent) THEN
          RAISE EXCEPTION 'model attempt scope denied' USING ERRCODE='42501';
        END IF;
        -- Narrow accounting exception: original trusted admission, not a live
        -- claim, authorizes an append-only billing fact after ownership loss.
        INSERT INTO agents.model_attempts(id,tenant_id,job_id,agent_version_id,model,
          occurred_at,latency_ms,input_tokens,output_tokens,status,error_code)
          VALUES(p_id,platform.current_tenant_id(),p_job,p_agent,p_model,p_occurred,p_latency,
            p_input,p_output,p_status,p_error) ON CONFLICT(id) DO NOTHING;
        GET DIAGNOSTICS inserted=ROW_COUNT;
        IF inserted=1 AND p_input IS NOT NULL AND p_output IS NOT NULL THEN
          INSERT INTO agents.usage_events(id,tenant_id,request_kind,agent_version_id,job_id,model,
            occurred_at,latency_ms,input_tokens,output_tokens)
            VALUES(p_id,platform.current_tenant_id(),'whatsapp.ai.reply',p_agent,p_job,p_model,
              p_occurred,p_latency,p_input,p_output) ON CONFLICT(id) DO NOTHING;
        END IF;
        RETURN inserted=1;
      END $$
    """)
    op.execute("""
      REVOKE ALL ON FUNCTION agents.record_messaging_model_attempt(
        uuid,uuid,uuid,text,timestamptz,integer,bigint,bigint,text,text) FROM PUBLIC
    """)
    op.execute("""
      GRANT EXECUTE ON FUNCTION agents.record_messaging_model_attempt(
        uuid,uuid,uuid,text,timestamptz,integer,bigint,bigint,text,text) TO platform_messaging
    """)


def downgrade():
    op.execute("""
      DROP FUNCTION agents.record_messaging_model_attempt(
        uuid,uuid,uuid,text,timestamptz,integer,bigint,bigint,text,text)
    """)
    op.execute("DROP TABLE agents.model_attempts")
    op.execute(
        "ALTER TABLE agents.usage_events DROP COLUMN agent_version_id,"
        "DROP COLUMN job_id,DROP COLUMN model"
    )
    op.execute("ALTER TABLE ops.jobs DROP COLUMN admitted_agent_version_id")
