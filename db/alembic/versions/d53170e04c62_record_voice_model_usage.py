"""Record voice model usage only for sessions belonging to the current tenant."""

from alembic import op

revision = "d53170e04c62"
down_revision = "c830d71e2f49"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
      CREATE FUNCTION agents.record_voice_usage(
        p_id uuid,p_session uuid,p_input bigint,p_output bigint,p_occurred timestamptz)
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE inserted integer;
      BEGIN
        IF platform.current_tenant_id() IS NULL OR p_id IS NULL
          OR p_input IS NULL OR p_output IS NULL OR p_occurred IS NULL
          OR p_input<0 OR p_output<0 THEN
          RAISE EXCEPTION 'invalid usage event' USING ERRCODE='22023';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM public.sessions WHERE session_id=p_session
          AND tenant_id=platform.current_tenant_id()) THEN
          RAISE EXCEPTION 'usage session unavailable' USING ERRCODE='42501';
        END IF;
        INSERT INTO agents.usage_events(
          id,tenant_id,request_kind,input_tokens,output_tokens,occurred_at)
          VALUES(p_id,platform.current_tenant_id(),'voice.llm',p_input,p_output,p_occurred)
          ON CONFLICT(id) DO NOTHING;
        GET DIAGNOSTICS inserted=ROW_COUNT;
        RETURN inserted=1;
      END $$
    """)
    op.execute(
        "REVOKE ALL ON FUNCTION "
        "agents.record_voice_usage(uuid,uuid,bigint,bigint,timestamptz) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        "agents.record_voice_usage(uuid,uuid,bigint,bigint,timestamptz) TO platform_voice"
    )


def downgrade():
    op.execute("DROP FUNCTION agents.record_voice_usage(uuid,uuid,bigint,bigint,timestamptz)")
