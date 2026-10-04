"""Tenant-scoped shadow memory sessions and immutable summary provenance.

Revision ID: f7d239a8b105
Revises: e6f128c7a904
"""

from alembic import op

revision = "f7d239a8b105"
down_revision = "e6f128c7a904"
branch_labels = None
depends_on = None


def _execute_statements(script: str) -> None:
    """Fixed DDL: preserve dollar-quoted bodies for asyncpg preparation."""
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


def upgrade():
    _execute_statements("""
      CREATE TABLE agents.messaging_memory_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES public.tenants(id)
        ON DELETE RESTRICT,
        conversation_id uuid NOT NULL REFERENCES messaging.conversations(id)
        ON DELETE RESTRICT,
        agent_version_id uuid NOT NULL REFERENCES agents.agent_profile_versions(id)
        ON DELETE RESTRICT,
        started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(tenant_id,id)
      );
      CREATE INDEX messaging_memory_sessions_latest ON agents.messaging_memory_sessions
        (tenant_id,conversation_id,last_activity_at DESC);
      CREATE TABLE agents.messaging_memory_summaries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        session_id uuid NOT NULL,
        covered_until_message_id uuid NOT NULL REFERENCES messaging.messages(id)
        ON DELETE RESTRICT,
        text text NOT NULL CHECK(length(text) BETWEEN 1 AND 4000),
        source_message_ids uuid[] NOT NULL CHECK(cardinality(source_message_ids) BETWEEN 1 AND 20),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(tenant_id,session_id) REFERENCES agents.messaging_memory_sessions(tenant_id,id)
        ON DELETE RESTRICT,
        UNIQUE(session_id,covered_until_message_id)
      );
      CREATE TABLE agents.customer_memory_facts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        session_id uuid NOT NULL,
        fact_key text NOT NULL CHECK(fact_key IN (
          'name','city','business_need','contact_preference','appointment_preference')),
        fact_value text NOT NULL CHECK(length(fact_value) BETWEEN 1 AND 1000),
        confidence text NOT NULL CHECK(confidence IN ('stated','verified')),
        source_message_id uuid NOT NULL REFERENCES messaging.messages(id)
        ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(tenant_id,session_id) REFERENCES agents.messaging_memory_sessions(tenant_id,id)
        ON DELETE RESTRICT,
        UNIQUE(session_id,fact_key,source_message_id)
      )
    """)
    for table in (
        "messaging_memory_sessions",
        "messaging_memory_summaries",
        "customer_memory_facts",
    ):
        op.execute(f"ALTER TABLE agents.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE agents.{table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""
          CREATE POLICY tenant_isolation ON agents.{table}
          USING(tenant_id=platform.current_tenant_id())
          WITH CHECK(tenant_id=platform.current_tenant_id())
        """)
        op.execute(
            f"GRANT SELECT ON agents.{table} TO platform_messaging,platform_voice,platform_web"
        )
    _execute_statements("""
      CREATE FUNCTION agents.resolve_messaging_memory_session(
        p_conversation uuid,p_agent uuid,p_idle_hours integer DEFAULT 12)
      RETURNS TABLE(id uuid,started_at timestamptz,last_activity_at timestamptz)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_session agents.messaging_memory_sessions%ROWTYPE;
      BEGIN
        IF p_idle_hours NOT BETWEEN 1 AND 168 OR p_idle_hours IS NULL THEN
          RAISE EXCEPTION 'invalid session idle interval' USING ERRCODE='22023';
        END IF;
        PERFORM 1 FROM messaging.conversations c JOIN public.tenants t ON t.id=c.tenant_id
          WHERE c.id=p_conversation AND c.tenant_id=platform.current_tenant_id()
            AND t.status='active' FOR UPDATE OF c;
        IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM agents.agent_profile_versions a
          WHERE a.id=p_agent AND a.tenant_id=platform.current_tenant_id()
            AND a.published_at IS NOT NULL AND a.validation_status='valid') THEN
          RAISE EXCEPTION 'memory scope denied' USING ERRCODE='42501';
        END IF;
        SELECT s.* INTO v_session FROM agents.messaging_memory_sessions s
          WHERE s.conversation_id=p_conversation AND s.tenant_id=platform.current_tenant_id()
            AND s.agent_version_id=p_agent
            AND s.last_activity_at>clock_timestamp()-make_interval(hours=>p_idle_hours)
          ORDER BY s.last_activity_at DESC LIMIT 1;
        IF v_session.id IS NULL THEN
          INSERT INTO agents.messaging_memory_sessions(
            tenant_id,conversation_id,agent_version_id,started_at)
            VALUES(platform.current_tenant_id(),p_conversation,p_agent,
              COALESCE((SELECT MAX(m.created_at) FROM messaging.messages m
                WHERE m.conversation_id=p_conversation AND m.tenant_id=platform.current_tenant_id()
                  AND m.direction='inbound' AND m.sender_type='contact'),clock_timestamp()))
            RETURNING * INTO v_session;
        ELSE
          UPDATE agents.messaging_memory_sessions s SET last_activity_at=clock_timestamp()
            WHERE s.id=v_session.id RETURNING s.* INTO v_session;
        END IF;
        RETURN QUERY SELECT v_session.id,v_session.started_at,v_session.last_activity_at;
      END $$;
      REVOKE ALL ON FUNCTION agents.resolve_messaging_memory_session(uuid,uuid,integer) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION agents.resolve_messaging_memory_session(uuid,uuid,integer)
        TO platform_messaging;
    """)
    _execute_statements("""
      CREATE FUNCTION agents.write_messaging_memory_summary(
        p_session uuid,p_covered uuid,p_sources uuid[],p_text text)
      RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_conversation uuid; v_started timestamptz; v_ended timestamptz; v_id uuid;
      BEGIN
        SELECT s.conversation_id,s.started_at,s.last_activity_at
          INTO v_conversation,v_started,v_ended FROM agents.messaging_memory_sessions s
          WHERE s.id=p_session AND s.tenant_id=platform.current_tenant_id();
        IF v_conversation IS NULL OR cardinality(p_sources) NOT BETWEEN 1 AND 20
          OR p_sources IS NULL OR p_covered IS NULL OR NOT(p_covered=ANY(p_sources))
          OR length(p_text) NOT BETWEEN 1 AND 4000 OR p_text IS NULL THEN
          RAISE EXCEPTION 'invalid summary scope' USING ERRCODE='42501';
        END IF;
        IF EXISTS(SELECT 1 FROM unnest(p_sources) source(id)
          LEFT JOIN messaging.messages m ON m.id=source.id
            AND m.conversation_id=v_conversation AND m.tenant_id=platform.current_tenant_id()
            AND m.direction='inbound' AND m.sender_type='contact'
            AND m.created_at>=v_started AND m.created_at<=v_ended
          WHERE m.id IS NULL) THEN
          RAISE EXCEPTION 'summary requires customer message provenance' USING ERRCODE='42501';
        END IF;
        IF p_covered IS DISTINCT FROM (SELECT m.id FROM messaging.messages m
          WHERE m.id=ANY(p_sources) ORDER BY m.created_at DESC,m.id DESC LIMIT 1) THEN
          RAISE EXCEPTION 'summary watermark must be newest source' USING ERRCODE='42501';
        END IF;
        INSERT INTO agents.messaging_memory_summaries(
          tenant_id,session_id,covered_until_message_id,source_message_ids,text)
          VALUES(platform.current_tenant_id(),p_session,p_covered,p_sources,p_text)
          ON CONFLICT(session_id,covered_until_message_id) DO NOTHING RETURNING id INTO v_id;
        IF v_id IS NULL THEN SELECT s.id INTO v_id FROM agents.messaging_memory_summaries s
          WHERE s.session_id=p_session AND s.covered_until_message_id=p_covered
            AND s.tenant_id=platform.current_tenant_id(); END IF;
        RETURN v_id;
      END $$;
      REVOKE ALL ON FUNCTION agents.write_messaging_memory_summary(uuid,uuid,uuid[],text)
        FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION agents.write_messaging_memory_summary(uuid,uuid,uuid[],text)
        TO platform_messaging;
      CREATE FUNCTION agents.write_customer_memory_fact(
        p_session uuid,p_source uuid,p_key text,p_value text)
      RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_id uuid;
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM agents.messaging_memory_sessions s
          JOIN messaging.messages m ON m.conversation_id=s.conversation_id
            AND m.tenant_id=s.tenant_id
          WHERE s.id=p_session AND s.tenant_id=platform.current_tenant_id()
            AND m.id=p_source AND m.direction='inbound' AND m.sender_type='contact'
            AND m.created_at>=s.started_at AND m.created_at<=s.last_activity_at
            AND position(p_value IN m.content_text)>0)
          OR p_key NOT IN (
            'name','city','business_need','contact_preference','appointment_preference')
          OR p_key IS NULL
          OR length(p_value) NOT BETWEEN 1 AND 1000 OR p_value IS NULL THEN
          RAISE EXCEPTION 'fact requires stated customer provenance' USING ERRCODE='42501';
        END IF;
        INSERT INTO agents.customer_memory_facts(
          tenant_id,session_id,source_message_id,fact_key,fact_value,confidence)
          VALUES(platform.current_tenant_id(),p_session,p_source,p_key,p_value,'stated')
          ON CONFLICT(session_id,fact_key,source_message_id) DO NOTHING RETURNING id INTO v_id;
        IF v_id IS NULL THEN SELECT f.id INTO v_id FROM agents.customer_memory_facts f
          WHERE f.session_id=p_session AND f.fact_key=p_key AND f.source_message_id=p_source
            AND f.tenant_id=platform.current_tenant_id(); END IF;
        RETURN v_id;
      END $$;
      REVOKE ALL ON FUNCTION agents.write_customer_memory_fact(uuid,uuid,text,text) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION agents.write_customer_memory_fact(uuid,uuid,text,text)
        TO platform_messaging;
    """)


def downgrade():
    op.execute("DROP FUNCTION agents.write_customer_memory_fact(uuid,uuid,text,text)")
    op.execute("DROP FUNCTION agents.write_messaging_memory_summary(uuid,uuid,uuid[],text)")
    op.execute("DROP FUNCTION agents.resolve_messaging_memory_session(uuid,uuid,integer)")
    op.execute("DROP TABLE agents.customer_memory_facts")
    op.execute("DROP TABLE agents.messaging_memory_summaries")
    op.execute("DROP TABLE agents.messaging_memory_sessions")
