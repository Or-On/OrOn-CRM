"""Deduplicated bound-session voice quality failure evidence."""

from alembic import op

revision = "ec624ebf31a6"
down_revision = "eb513dae2095"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
CREATE TABLE ops.voice_quality_alerts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 session_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('summary_persistence_unavailable','missing_session')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,session_id,reason),
 FOREIGN KEY(tenant_id,session_id) REFERENCES public.sessions(tenant_id,session_id)
 ON DELETE RESTRICT
);
        """
    )
    op.execute(
        """
ALTER TABLE ops.voice_quality_alerts ENABLE ROW LEVEL SECURITY;
        """
    )
    op.execute(
        """
ALTER TABLE ops.voice_quality_alerts FORCE ROW LEVEL SECURITY;
        """
    )
    op.execute(
        """
CREATE POLICY voice_quality_alerts_tenant ON ops.voice_quality_alerts
 USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
        """
    )
    op.execute(
        """
GRANT SELECT,INSERT ON ops.voice_quality_alerts TO platform_migrator;
        """
    )
    op.execute(
        """
CREATE FUNCTION ops.report_voice_quality_failure(p_session uuid,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid:=platform.current_tenant_id(); result uuid;
BEGIN
 IF t IS NULL OR p_reason IS NULL
 OR p_reason NOT IN ('summary_persistence_unavailable','missing_session')
 OR NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.tenant_id=t AND s.session_id=p_session)
 OR NOT EXISTS(SELECT 1 FROM public.session_events e WHERE e.tenant_id=t AND e.session_id=p_session
   AND e.event_type='voice.agent.binding.v1' AND e.payload->>'agent_version_id' IS NOT NULL)
 THEN RAISE EXCEPTION 'voice_quality_alert_binding_unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO ops.voice_quality_alerts(tenant_id,session_id,reason) VALUES(t,p_session,p_reason)
 ON CONFLICT(tenant_id,session_id,reason) DO NOTHING RETURNING id INTO result;
 IF result IS NULL THEN SELECT id INTO STRICT result FROM ops.voice_quality_alerts
 WHERE tenant_id=t AND session_id=p_session AND reason=p_reason; END IF;
 RETURN result;
END $$;
        """
    )
    op.execute(
        """
ALTER FUNCTION ops.report_voice_quality_failure(uuid,text) OWNER TO platform_migrator;
        """
    )
    op.execute(
        """
REVOKE ALL ON FUNCTION ops.report_voice_quality_failure(uuid,text) FROM PUBLIC;
        """
    )
    op.execute(
        """
GRANT EXECUTE ON FUNCTION ops.report_voice_quality_failure(uuid,text) TO platform_voice;
        """
    )
    op.execute(
        """
REVOKE ALL ON ops.voice_quality_alerts FROM platform_voice;
        """
    )


def downgrade() -> None:
    # Never discard accumulated operator evidence during schema rollback.
    op.execute("""
      DO $$ BEGIN
        IF EXISTS(SELECT 1 FROM ops.voice_quality_alerts) THEN
          RAISE EXCEPTION 'voice_quality_alert_evidence_requires_reviewed_retention';
        END IF;
      END $$
    """)
    op.execute("DROP FUNCTION ops.report_voice_quality_failure(uuid,text)")
    op.execute("DROP TABLE ops.voice_quality_alerts")
