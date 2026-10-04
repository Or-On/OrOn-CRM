"""Stamp AI-authored context using a fresh messaging claim, never caller metadata.

Revision ID: e4fad637592e
Revises: e3f9c526481d
"""

from alembic import op

revision = "e4fad637592e"
down_revision = "e3f9c526481d"
branch_labels = None
depends_on = None


def upgrade():
    uuid_pattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    op.execute(f"""
      CREATE FUNCTION audit.protect_ai_context_provenance() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE source_job uuid; source_token uuid;
      BEGIN
        IF TG_OP='UPDATE' AND OLD.metadata ? 'aiContextProvenance' THEN
          RAISE EXCEPTION 'AI context provenance is immutable' USING ERRCODE='42501';
        END IF;
        IF NEW.metadata ? 'aiContextProvenance' THEN
          RAISE EXCEPTION 'AI context provenance is server assigned' USING ERRCODE='42501';
        END IF;
        IF TG_OP='INSERT' AND current_user='platform_messaging'
          AND NEW.action IN ('conversation.ai_handoff_ticket','conversation.ai_model_failure')
          AND NEW.metadata->>'sourceJobId' ~ '{uuid_pattern}'
          AND NEW.metadata->>'sourceClaimToken' ~ '{uuid_pattern}' THEN
          source_job := (NEW.metadata->>'sourceJobId')::uuid;
          source_token := (NEW.metadata->>'sourceClaimToken')::uuid;
          PERFORM 1 FROM ops.jobs j WHERE j.id=source_job
            AND j.tenant_id=NEW.tenant_id AND j.tenant_id=platform.current_tenant_id()
            AND j.claim_token=source_token AND j.status='running'
            AND j.lease_expires_at>clock_timestamp()
            AND j.job_type IN (
              'whatsapp.ai.reply','whatsapp.ai.call','whatsapp.audio.transcribe') FOR SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'AI context claim is no longer owned' USING ERRCODE='42501';
          END IF;
          NEW.metadata := NEW.metadata ||
            jsonb_build_object('aiContextProvenance','worker_verified_v1');
        END IF;
        NEW.metadata := NEW.metadata - 'sourceClaimToken';
        RETURN NEW;
      END $$
    """)
    op.execute("REVOKE ALL ON FUNCTION audit.protect_ai_context_provenance() FROM PUBLIC")
    op.execute("""
      CREATE TRIGGER protect_ai_context_provenance BEFORE INSERT OR UPDATE ON audit.records
      FOR EACH ROW EXECUTE FUNCTION audit.protect_ai_context_provenance()
    """)


def downgrade():
    op.execute("DROP TRIGGER protect_ai_context_provenance ON audit.records")
    op.execute("DROP FUNCTION audit.protect_ai_context_provenance()")
