import uuid

import pytest
from oron_common import CallContext, Direction
from pydantic import ValidationError

TENANT_ID = uuid.UUID("00000000-0000-0000-0000-0000000000aa")

FLOW_ID = uuid.uuid4()


def test_session_id_defaults_to_uuid():
    ctx = CallContext(call_id="c1", direction="inbound", flow_id=FLOW_ID, tenant_id=TENANT_ID)
    assert isinstance(ctx.session_id, uuid.UUID)
    assert ctx.provider == "livekit"
    assert ctx.from_number is None
    assert ctx.raw_metadata == {}


def test_session_ids_are_unique():
    assert (
        CallContext(
            call_id="a", direction="inbound", flow_id=FLOW_ID, tenant_id=TENANT_ID
        ).session_id
        != CallContext(
            call_id="b", direction="inbound", flow_id=FLOW_ID, tenant_id=TENANT_ID
        ).session_id
    )


def test_accepts_an_explicit_session_id():
    sid = uuid.uuid4()
    ctx = CallContext(
        call_id="c2",
        provider="livekit",
        direction="outbound",
        session_id=sid,
        flow_id=FLOW_ID,
        tenant_id=TENANT_ID,
    )
    assert ctx.session_id == sid


def test_a_transport_with_no_implementation_is_rejected_at_the_boundary():
    """`provider` is the transport, not the carrier. Twilio was listed here but
    never implemented — the registry has only livekit, so it failed deep in
    build_transport_params instead of on construction. Carriers are swapped in
    the SIP trunk's allowed_addresses, and never reach this field."""
    with pytest.raises(ValidationError):
        CallContext(
            call_id="c4",
            provider="twilio",
            direction="inbound",
            flow_id=FLOW_ID,
            tenant_id=TENANT_ID,
        )


def test_direction_is_an_enum():
    ctx = CallContext(call_id="c3", direction="inbound", flow_id=FLOW_ID, tenant_id=TENANT_ID)
    assert ctx.direction is Direction.INBOUND
    with pytest.raises(ValidationError):
        CallContext(call_id="c4", direction="sideways", flow_id=FLOW_ID, tenant_id=TENANT_ID)


def test_tts_voice_defaults_to_none_and_is_settable():
    assert (
        CallContext(
            call_id="c5", direction="inbound", flow_id=FLOW_ID, tenant_id=TENANT_ID
        ).tts_voice
        is None
    )
    assert (
        CallContext(
            call_id="c6",
            direction="inbound",
            tts_voice="Kore",
            flow_id=FLOW_ID,
            tenant_id=TENANT_ID,
        ).tts_voice
        == "Kore"
    )
