# ruff: noqa: E501 -- SQL fixture statements are clearer unwrapped.
"""The inbound-call reconciliation report on synthetic ledger and session data."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from scripts.audit_voice_intake import (
    INQUIRY_OPEN,
    NO_INTAKE,
    NOT_ADMITTED,
    UNROUTABLE,
    collect,
    recovery_dry_run,
    room_session_id,
)

pytestmark = [pytest.mark.postgres, pytest.mark.integration]

DID = "+97239990001"


def _joined(room: str, caller: str | None, did: str) -> str:
    attributes = {"sip.trunkPhoneNumber": did}
    if caller is not None:
        attributes["sip.phoneNumber"] = caller
    return json.dumps(
        {
            "event": "participant_joined",
            "room": {"name": room},
            "participant": {"identity": "sip-caller", "kind": "SIP", "attributes": attributes},
        }
    )


async def test_every_inbound_call_gets_a_disposition_and_losses_are_listed_for_review(pg):
    tenant, contact = uuid4(), uuid4()
    await pg.execute(
        "INSERT INTO tenants(id,name,slug) VALUES($1,'Audit fixture',$2)", tenant, f"audit-{tenant}"
    )
    await pg.execute(
        "INSERT INTO public.phone_numbers(id,e164,tenant_id,dispatch_rule_id,flow_id) VALUES($1,$2,$3,'rule',$4)",
        uuid4(),
        DID,
        tenant,
        uuid4(),
    )
    await pg.execute(
        "INSERT INTO crm.contacts(id,tenant_id,name) VALUES($1,$2,'Fixture')", contact, tenant
    )
    now = datetime.now(UTC)
    rows = [
        # Admission failed (the 0f7b3c9d2a61 failure shape) and the caller retried.
        (
            "r-fail-1",
            "+972502345671",
            DID,
            "failed",
            "dispatcher_handler_failed",
            now - timedelta(hours=5),
        ),
        (
            "r-fail-2",
            "+972502345671",
            DID,
            "failed",
            "dispatcher_handler_failed",
            now - timedelta(hours=5) + timedelta(minutes=3),
        ),
        # A call to a number no tenant owns.
        (
            "r-unroutable",
            "+972502345672",
            "+97239990999",
            "quarantined",
            "unregistered_did",
            now - timedelta(hours=4),
        ),
        # Admitted with a visible inquiry.
        ("r-inquiry", "+972502345673", DID, "processed", None, now - timedelta(hours=3)),
        # Admitted, ended, nothing saved.
        ("r-empty", "+972502345674", DID, "processed", None, now - timedelta(hours=2)),
    ]
    for room, caller, did, status, error, at in rows:
        await pg.execute(
            "INSERT INTO ops.inbound_events(provider,provider_account_id,provider_event_id,event_type,payload,status,last_error_safe,received_at,attempts) "
            "VALUES('livekit','audit',$1,'participant_joined',$2::jsonb,$3,$4,$5,1)",
            f"EV_{room}_{uuid4().hex[:6]}",
            _joined(room, caller, did),
            status,
            error,
            at,
        )
    for room, ended in (("r-inquiry", True), ("r-empty", True)):
        session = room_session_id(room)
        await pg.execute(
            "INSERT INTO public.sessions(session_id,tenant_id,contact_id,provider,direction,room,status,flow_id,ended_at) "
            "VALUES($1,$2,$3,'livekit','inbound',$4,'ended',$5,CASE WHEN $6 THEN now() END)",
            session,
            tenant,
            contact,
            room,
            uuid4(),
            ended,
        )
    await pg.execute(
        "INSERT INTO support.tickets(tenant_id,reference,attachment_key,contact_id,subject,source_channel,stage,handling_mode) "
        "VALUES($1,'T-AUDIT-1',$2,$3,'Phone inquiry','voice','awaiting_human','human')",
        tenant,
        f"voice-session:{room_session_id('r-inquiry')}",
        contact,
    )

    traces, report = await collect(
        pg,
        now - timedelta(days=1),
        now + timedelta(minutes=1),
        tenant_id=None,
        hash_key=b"test-key",
    )
    audited = {trace.room: trace for trace in traces}
    assert audited["r-fail-1"].disposition == NOT_ADMITTED
    assert audited["r-unroutable"].disposition == UNROUTABLE
    assert audited["r-inquiry"].disposition == INQUIRY_OPEN
    assert audited["r-inquiry"].ticket_reference == "T-AUDIT-1"
    assert audited["r-empty"].disposition == NO_INTAKE
    assert report.counts[NOT_ADMITTED] == 2
    # Sanitized: no caller number anywhere in the report.
    assert "+972502345671" not in json.dumps([trace.__dict__ for trace in traces])
    recovery = recovery_dry_run(traces)
    dispositions = [item["disposition"] for item in recovery]
    assert dispositions == [NOT_ADMITTED, NO_INTAKE]
    assert recovery[0]["repeat_attempts"] == 1
    assert recovery[0]["provenance"]["inbound_event_id"]
    assert any("provider" in gap for gap in report.coverage_gaps)
