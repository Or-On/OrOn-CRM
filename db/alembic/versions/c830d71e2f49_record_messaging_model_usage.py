"""Record provider-reported messaging usage under the trusted tenant scope."""

from alembic import op

revision = "c830d71e2f49"
down_revision = "b672f9a6c310"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
      CREATE FUNCTION agents.record_messaging_usage(
        p_id uuid,p_input bigint,p_output bigint,p_latency integer)
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE inserted integer;
      BEGIN
        IF platform.current_tenant_id() IS NULL OR p_id IS NULL
          OR p_input IS NULL OR p_output IS NULL
          OR p_latency IS NULL OR p_input<0 OR p_output<0 OR p_latency<0 THEN
          RAISE EXCEPTION 'invalid usage event' USING ERRCODE='22023';
        END IF;
        INSERT INTO agents.usage_events(
          id,tenant_id,request_kind,input_tokens,output_tokens,latency_ms)
          VALUES(p_id,platform.current_tenant_id(),'whatsapp.ai.reply',p_input,p_output,p_latency)
          ON CONFLICT(id) DO NOTHING;
        GET DIAGNOSTICS inserted=ROW_COUNT;
        RETURN inserted=1;
      END $$
    """)
    op.execute(
        "REVOKE ALL ON FUNCTION agents.record_messaging_usage(uuid,bigint,bigint,integer) "
        "FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION agents.record_messaging_usage(uuid,bigint,bigint,integer) "
        "TO platform_messaging"
    )


def downgrade():
    op.execute("DROP FUNCTION agents.record_messaging_usage(uuid,bigint,bigint,integer)")
