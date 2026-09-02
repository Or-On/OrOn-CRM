"""What every span in a call's trace is tagged with.

The trace answers "why was this call slow"; the session row answers "who was it
and what did it cost". Keeping the caller's number on the row and out of the
trace is the whole point of the split — see `conversation_span_attributes`.
"""

import uuid

from oron_agent.tracing import conversation_span_attributes
from oron_common import CallContext
from oron_common.context import Direction


def _ctx(direction: Direction = Direction.OUTBOUND) -> CallContext:
    return CallContext(
        call_id="SCL_pecXnXmwArX7",
        direction=direction,
        from_number="+972539649614",
        to_number="+972500000000",
        flow_id=uuid.UUID("5714eed1-a8fe-419a-9492-d65d4d9d68c3"),
        tenant_id=uuid.UUID("f101b386-01fc-4a12-978d-fdca0c90e23b"),
    )


def test_a_trace_says_which_leg_the_call_came_in_on():
    """Without it a browser rehearsal is indistinguishable from a voter's call,
    which silently mixes test traffic into the campaign's numbers. Measured
    2026-08-03: six traced conversations, no way to tell PSTN from browser."""
    assert conversation_span_attributes(_ctx(Direction.BROWSER))["direction"] == "browser"
    assert conversation_span_attributes(_ctx(Direction.INBOUND))["direction"] == "inbound"
    assert conversation_span_attributes(_ctx(Direction.OUTBOUND))["direction"] == "outbound"


def test_the_carrier_call_id_is_carried_so_a_trace_joins_the_sip_log():
    """`SCL_…` is what LiveKit and the SIP logs key on. Without it, joining a
    trace to its signalling means matching on wall clock."""
    assert conversation_span_attributes(_ctx())["call_id"] == "SCL_pecXnXmwArX7"


def test_no_phone_number_ever_reaches_the_trace():
    """Phoenix runs `Authentication: False` — the firewall is its only control —
    and its spans already carry the caller's speech. The number is encrypted on
    the session row (KmsFieldCipher) behind RLS precisely so it is not casually
    readable; putting it here would walk around that. Identity stays reachable
    via `conversation.id`, which is the session_id.

    Asserted over the values, not a field list, so adding a new attribute that
    happens to embed a number fails here rather than in production."""
    values = " ".join(conversation_span_attributes(_ctx()).values())
    assert "+972539649614" not in values
    assert "+972500000000" not in values
    assert "972" not in values


def test_the_tenant_and_flow_tags_that_phoenix_already_filters_on_are_kept():
    attrs = conversation_span_attributes(_ctx())
    assert attrs["tenant_id"] == "f101b386-01fc-4a12-978d-fdca0c90e23b"
    assert attrs["flow_id"] == "5714eed1-a8fe-419a-9492-d65d4d9d68c3"
