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


def test_caller_address_gender_is_typed_and_optional():
    assert (
        CallContext(
            call_id="c7", direction="outbound", flow_id=FLOW_ID, tenant_id=TENANT_ID
        ).caller_gender
        is None
    )
    assert (
        CallContext(
            call_id="c8",
            direction="outbound",
            flow_id=FLOW_ID,
            tenant_id=TENANT_ID,
            caller_gender="male",
        ).caller_gender
        == "male"
    )
    with pytest.raises(ValidationError):
        CallContext(
            call_id="c9",
            direction="outbound",
            flow_id=FLOW_ID,
            tenant_id=TENANT_ID,
            caller_gender="unknown",
        )


def test_cross_channel_context_carries_only_complete_opaque_references():
    conversation_id = uuid.uuid4()
    contact_id = uuid.uuid4()
    handoff_id = uuid.uuid4()
    ctx = CallContext(
        call_id="c10",
        direction="outbound",
        flow_id=FLOW_ID,
        tenant_id=TENANT_ID,
        contact_id=contact_id,
        source_conversation_id=conversation_id,
        handoff_id=handoff_id,
    )
    assert ctx.source_conversation_id == conversation_id
    assert ctx.contact_id == contact_id
    assert ctx.handoff_id == handoff_id
    assert "conversation_context" not in ctx.model_dump()
    with pytest.raises(ValidationError):
        CallContext(
            call_id="c11",
            direction="outbound",
            flow_id=FLOW_ID,
            tenant_id=TENANT_ID,
            source_conversation_id=conversation_id,
        )


def test_optional_published_bindings_round_trip_in_call_context():
    old = CallContext(call_id="legacy", direction="outbound", flow_id=FLOW_ID, tenant_id=TENANT_ID)
    assert old.flow_version is None and old.agent_version_id is None
    agent_version_id = uuid.uuid4()
    pinned = old.model_copy(update={"flow_version": 3, "agent_version_id": agent_version_id})
    parsed = CallContext.model_validate_json(pinned.model_dump_json())
    assert parsed.flow_version == 3 and parsed.agent_version_id == agent_version_id


@pytest.mark.parametrize("version", [0, -1, 1.5, True, "1"])
def test_flow_version_requires_positive_integer(version):
    with pytest.raises(ValidationError):
        CallContext(
            call_id="invalid",
            direction="outbound",
            flow_id=FLOW_ID,
            tenant_id=TENANT_ID,
            flow_version=version,
        )
