"""Fence and replay signed LiveKit webhook admission."""

from alembic import op

revision = "e93f1b8c0e73"
down_revision = "e82e0a7b9d62"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
ALTER TABLE ops.inbound_events ADD COLUMN voice_claim_token uuid;
        """
    )
    op.execute(
        """
ALTER TABLE ops.inbound_events ADD COLUMN voice_lease_expires_at timestamptz;
        """
    )
    op.execute(
        """
CREATE INDEX inbound_events_livekit_due_idx ON ops.inbound_events (provider_account_id,
available_at, received_at) WHERE provider='livekit' AND tenant_id IS NULL AND status IN
('received','failed','processing');
        """
    )
    op.execute(
        """
CREATE FUNCTION ops.accept_livekit_event(a text, eid text, kind text, body jsonb)
RETURNS TABLE(event_id uuid, duplicate boolean) LANGUAGE plpgsql SECURITY DEFINER SET
search_path=pg_catalog AS $$
DECLARE found ops.inbound_events%ROWTYPE; inserted uuid;
BEGIN
IF a IS NULL OR length(a) NOT BETWEEN 1 AND 200 OR eid IS NULL OR length(eid) NOT
BETWEEN 1 AND 200 OR kind IS NULL OR length(kind) NOT BETWEEN 1 AND 200 OR
jsonb_typeof(body) IS DISTINCT FROM 'object' OR octet_length(body::text)>262144 OR
body->>'id' IS DISTINCT FROM eid OR body->>'event' IS DISTINCT FROM kind THEN RAISE
EXCEPTION 'invalid_livekit_envelope' USING ERRCODE='22023'; END IF;
INSERT INTO
ops.inbound_events(tenant_id,provider,provider_account_id,provider_event_id,event_type,payload)
VALUES(NULL,'livekit',a,eid,kind,body) ON
CONFLICT(provider,provider_account_id,provider_event_id) DO NOTHING RETURNING id INTO
inserted;
SELECT * INTO STRICT found FROM ops.inbound_events WHERE provider='livekit' AND
provider_account_id=a AND provider_event_id=eid;
IF found.tenant_id IS NOT NULL OR found.event_type IS DISTINCT FROM kind OR
found.payload IS DISTINCT FROM body THEN RAISE EXCEPTION 'livekit_envelope_conflict'
USING ERRCODE='22023'; END IF;
RETURN QUERY SELECT found.id,inserted IS NULL;
END $$;
        """
    )
    op.execute(
        """
CREATE FUNCTION ops.claim_livekit_events(a text,w text,n integer,lease integer)
RETURNS SETOF ops.inbound_events LANGUAGE plpgsql SECURITY DEFINER SET
search_path=pg_catalog AS $$
BEGIN
IF a IS NULL OR length(a) NOT BETWEEN 1 AND 200 OR w IS NULL OR length(w) NOT BETWEEN 1
AND 200 OR n IS NULL OR n NOT BETWEEN 1 AND 16 OR lease IS NULL OR lease NOT BETWEEN 10
AND 120 THEN RAISE EXCEPTION 'invalid_livekit_claim' USING ERRCODE='22023'; END IF;
UPDATE ops.inbound_events SET
status='quarantined',processed_at=clock_timestamp(),locked_at=NULL,locked_by=NULL,voice_claim_token=NULL,voice_lease_expires_at=NULL,last_error_safe='dispatcher_attempts_exhausted'
WHERE provider='livekit' AND provider_account_id=a AND tenant_id IS NULL AND
attempts>=max_attempts AND (status IN ('received','failed') OR (status='processing' AND
COALESCE(voice_lease_expires_at,locked_at+interval '300 seconds'
,received_at)<clock_timestamp()));
RETURN QUERY WITH due AS (SELECT e.id FROM ops.inbound_events e WHERE
e.provider='livekit' AND e.provider_account_id=a AND e.tenant_id IS NULL AND
e.attempts<e.max_attempts AND NOT EXISTS (SELECT 1 FROM ops.inbound_events prior WHERE
prior.provider='livekit' AND prior.provider_account_id=a AND prior.tenant_id IS NULL AND
prior.payload#>>'{room,name}' IS NOT DISTINCT FROM e.payload#>>'{room,name}' AND
prior.receipt_sequence<e.receipt_sequence AND prior.status IN
('received','failed','processing')) AND ((status IN ('received','failed') AND
available_at<=clock_timestamp()) OR (status='processing' AND
COALESCE(voice_lease_expires_at,locked_at+interval '300 seconds'
,received_at)<clock_timestamp())) ORDER BY received_at,id LIMIT n FOR UPDATE SKIP
LOCKED)
UPDATE ops.inbound_events e SET
status='processing',attempts=e.attempts+1,locked_at=clock_timestamp(),locked_by=w,voice_claim_token=gen_random_uuid(),voice_lease_expires_at=clock_timestamp()+make_interval(secs=>lease),last_error_safe=NULL
FROM due WHERE e.id=due.id RETURNING e.*;
END $$;
        """
    )
    op.execute(
        """
CREATE FUNCTION ops.renew_livekit_claim(a text,i uuid,w text,t uuid,lease integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed integer;
BEGIN
IF lease IS NULL OR lease NOT BETWEEN 10 AND 120 THEN RAISE EXCEPTION
'invalid_livekit_lease' USING ERRCODE='22023'; END IF;
UPDATE ops.inbound_events SET
voice_lease_expires_at=clock_timestamp()+make_interval(secs=>lease) WHERE id=i AND
provider='livekit' AND tenant_id IS NULL AND provider_account_id=a AND
status='processing' AND locked_by=w AND voice_claim_token=t AND
voice_lease_expires_at>clock_timestamp(); GET DIAGNOSTICS changed=ROW_COUNT; RETURN
changed=1;
END $$;
        """
    )
    op.execute(
        """
CREATE FUNCTION ops.settle_livekit_claim(a text,i uuid,w text,t uuid,outcome text,reason
text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed integer;
BEGIN
IF outcome NOT IN ('processed','failed','quarantined') OR (outcome='processed' AND
reason IS NOT NULL) OR (outcome='failed' AND reason IS DISTINCT FROM
'dispatcher_handler_failed' ) OR (outcome='quarantined' AND (reason IS NULL OR reason
NOT IN
('missing_did','malformed_did','unregistered_did','voice_admission_unavailable','voice_agent_unavailable')))
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
        """
    )
    op.execute(
        """
ALTER FUNCTION ops.accept_livekit_event(text,text,text,jsonb) OWNER TO
platform_migrator;
        """
    )
    op.execute(
        """
ALTER FUNCTION ops.claim_livekit_events(text,text,integer,integer) OWNER TO
platform_migrator;
        """
    )
    op.execute(
        """
ALTER FUNCTION ops.renew_livekit_claim(text,uuid,text,uuid,integer) OWNER TO
platform_migrator;
        """
    )
    op.execute(
        """
ALTER FUNCTION ops.settle_livekit_claim(text,uuid,text,uuid,text,text) OWNER TO
platform_migrator;
        """
    )
    op.execute(
        """
REVOKE ALL ON FUNCTION
ops.accept_livekit_event(text,text,text,jsonb),ops.claim_livekit_events(text,text,integer,integer),ops.renew_livekit_claim(text,uuid,text,uuid,integer),ops.settle_livekit_claim(text,uuid,text,uuid,text,text)
FROM PUBLIC;
        """
    )
    op.execute(
        """
GRANT EXECUTE ON FUNCTION
ops.accept_livekit_event(text,text,text,jsonb),ops.claim_livekit_events(text,text,integer,integer),ops.renew_livekit_claim(text,uuid,text,uuid,integer),ops.settle_livekit_claim(text,uuid,text,uuid,text,text)
TO platform_voice;
        """
    )
    op.execute(
        """
REVOKE SELECT,INSERT,UPDATE ON ops.inbound_events FROM platform_voice;
        """
    )


def downgrade() -> None:
    # Old binaries remain unready; broad event-table grants are never restored.
    op.execute("DROP FUNCTION ops.settle_livekit_claim(text,uuid,text,uuid,text,text)")
    op.execute("DROP FUNCTION ops.renew_livekit_claim(text,uuid,text,uuid,integer)")
    op.execute("DROP FUNCTION ops.claim_livekit_events(text,text,integer,integer)")
    op.execute("DROP FUNCTION ops.accept_livekit_event(text,text,text,jsonb)")
    op.execute("DROP INDEX ops.inbound_events_livekit_due_idx")
    op.execute("ALTER TABLE ops.inbound_events DROP COLUMN voice_claim_token")
    op.execute("ALTER TABLE ops.inbound_events DROP COLUMN voice_lease_expires_at")
