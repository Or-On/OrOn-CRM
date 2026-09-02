from oron_agent.flows.handlers.library import standard_handlers
from oron_agent.flows.runtime import HandlerContext

BOOLEAN = {"arg": "grinding", "on": {"true": "affirmed", "false": "declined"}}


GATE = {
    "required": ["vote_intent", "vote_reason"],
    "reasks": {"vote_intent": "למי תצביעו?", "vote_reason": "ולמה דווקא הם?"},
    "attempts_var": "ask_attempts",
    "reask_var": "ask_reask",
    "max_attempts": 2,
}


def _ctx(args: dict, config: dict, state: dict | None = None) -> HandlerContext:
    return HandlerContext(args=args, state=state or {}, config=config)


async def test_goto_returns_its_configured_route():
    result = await standard_handlers()["goto"](_ctx({}, {"route": "next"}))
    assert result.route == "next" and result.data == {}


async def test_route_by_maps_booleans():
    on_true = await standard_handlers()["route_by"](_ctx({"grinding": True}, BOOLEAN))
    on_false = await standard_handlers()["route_by"](_ctx({"grinding": False}, BOOLEAN))
    assert on_true.route == "affirmed" and on_false.route == "declined"


async def test_route_by_stores_the_value_when_sets_is_given():
    result = await standard_handlers()["route_by"](
        _ctx({"grinding": True}, {**BOOLEAN, "sets": "answer"})
    )
    assert result.data == {"answer": True}


async def test_route_by_maps_string_values():
    result = await standard_handlers()["route_by"](
        _ctx({"size": "large"}, {"arg": "size", "on": {"large": "big", "small": "wee"}})
    )
    assert result.route == "big"


async def test_route_by_unmapped_or_missing_value_routes_to_error():
    unmapped = await standard_handlers()["route_by"](
        _ctx({"size": "medium"}, {"arg": "size", "on": {"large": "big"}})
    )
    missing = await standard_handlers()["route_by"](
        _ctx({}, {"arg": "size", "on": {"large": "big"}})
    )
    assert unmapped.route == "error" and missing.route == "error"


async def test_collect_gate_passes_when_every_required_value_is_present():
    result = await standard_handlers()["collect_gate"](
        _ctx({"vote_intent": "הליכוד", "vote_reason": "כלכלה"}, GATE)
    )
    assert result.route == "done"
    assert result.data["vote_intent"] == "הליכוד"
    assert result.data["ask_attempts"] == 0


async def test_collect_gate_keeps_what_was_captured_and_reasks_only_the_gap():
    """The repair turn must not re-ask for something already answered — that is
    what makes a second attempt feel like being listened to rather than looped."""
    result = await standard_handlers()["collect_gate"](_ctx({"vote_intent": "הליכוד"}, GATE))
    assert result.route == "retry"
    assert result.data["vote_intent"] == "הליכוד"
    assert result.data["ask_reask"] == "ולמה דווקא הם?"
    assert "למי תצביעו?" not in result.data["ask_reask"]


async def test_collect_gate_joins_the_reasks_for_several_missing_fields():
    result = await standard_handlers()["collect_gate"](_ctx({}, GATE))
    assert result.data["ask_reask"] == "למי תצביעו? ולמה דווקא הם?"


async def test_collect_gate_does_not_reask_a_value_banked_on_an_earlier_attempt():
    """The repair turn asks only for the gap, so the model answers with only the
    gap. Everything the caller already gave is in session, not in these args —
    reading only the args re-asks for it and spends the budget on it."""
    result = await standard_handlers()["collect_gate"](
        _ctx(
            {"vote_reason": "כלכלה"},
            GATE,
            state={"session": {"vote_intent": "הליכוד", "ask_attempts": 1}},
        )
    )
    assert result.route == "done"


async def test_collect_gate_gives_up_at_max_attempts_rather_than_looping():
    """Never stuck: the budget is spent, so the flow takes the author's exit."""
    result = await standard_handlers()["collect_gate"](
        _ctx({}, GATE, state={"session": {"ask_attempts": 1}})
    )
    assert result.route == "exhausted"
    assert result.data["ask_attempts"] == 2


async def test_collect_gate_treats_an_empty_string_as_missing():
    result = await standard_handlers()["collect_gate"](
        _ctx({"vote_intent": "", "vote_reason": "כלכלה"}, GATE)
    )
    assert result.route == "retry" and result.data["ask_reask"] == "למי תצביעו?"


async def test_collect_gate_ignores_optional_fields_it_was_not_given():
    result = await standard_handlers()["collect_gate"](
        _ctx(
            {"vote_intent": "הליכוד", "vote_reason": "כלכלה"}, {**GATE, "required": ["vote_intent"]}
        )
    )
    assert result.route == "done"
