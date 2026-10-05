"""Persist the signed inbound binding guard's safe quarantine outcomes.

Revision ID: af54b6c13e92
Revises: 9e43a5b02d81
"""

from alembic import op

revision = "af54b6c13e92"
down_revision = "9e43a5b02d81"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Only three closed reason constants change. Preserve all claim-fencing
    # predicates, retry/exhaustion semantics and the least-privilege interface.
    op.execute("""
CREATE OR REPLACE FUNCTION ops.settle_livekit_claim(a text,i uuid,w text,t uuid,outcome text,reason
text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed integer;
BEGIN
IF outcome NOT IN ('processed','failed','quarantined') OR (outcome='processed' AND
reason IS NOT NULL) OR (outcome='failed' AND reason IS DISTINCT FROM
'dispatcher_handler_failed' ) OR (outcome='quarantined' AND (reason IS NULL OR reason
NOT IN
('missing_did','malformed_did','unregistered_did','voice_admission_unavailable','voice_agent_unavailable',
'missing_inbound_rule','inbound_rule_mismatch','inbound_transport_mismatch')))
THEN RAISE EXCEPTION 'invalid_livekit_settlement' USING ERRCODE='22023'; END IF;
UPDATE ops.inbound_events SET status=CASE WHEN outcome='failed' AND
attempts>=max_attempts THEN 'quarantined' ELSE outcome END,processed_at=CASE WHEN
outcome='failed' AND attempts<max_attempts THEN NULL ELSE clock_timestamp()
END,available_at=CASE WHEN outcome='failed' THEN
clock_timestamp()+make_interval(secs=>LEAST(60,attempts*5)) ELSE available_at
END,last_error_safe=CASE WHEN outcome='failed' AND attempts>=max_attempts THEN
'dispatcher_attempts_exhausted' ELSE reason
END,locked_at=NULL,locked_by=NULL,voice_claim_token=NULL,voice_lease_expires_at=NULL
WHERE id=i AND provider='livekit' AND tenant_id IS NULL AND provider_account_id=a AND
status='processing' AND locked_by=w AND voice_claim_token=t AND
voice_lease_expires_at>clock_timestamp(); GET DIAGNOSTICS changed=ROW_COUNT; RETURN
changed=1;
END $$;
    """)
    signature = "ops.settle_livekit_claim(text,uuid,text,uuid,text,text)"
    op.execute(f"ALTER FUNCTION {signature} OWNER TO platform_migrator")
    op.execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION {signature} TO platform_voice")


def downgrade() -> None:
    # Keep the additive safe vocabulary during application/schema rollback:
    # previous binaries accept it, and still-running binding guards require it.
    # No table, privilege or receipt is added/removed by this revision.
    pass
