from uuid import uuid4

import pytest
from control_api.voice_flow_adapter import adapt_retained_voice_flow
from oron_flows.compose import Composition, expand


def test_adapter_preserves_frozen_hebrew_composition_and_version() -> None:
    identifier = uuid4()
    composition = Composition.model_validate(
        {
            "flow": {"id": str(identifier), "version": 3, "language": "he"},
            "steps": [
                {"id": "welcome", "use": "inform", "say": "שלום"},
                {"id": "done", "use": "announce", "say": "להתראות"},
            ],
        }
    )
    frozen = expand(composition)
    adapted = adapt_retained_voice_flow(identifier, 3, frozen.model_dump(mode="json"))
    assert adapted == frozen
    assert adapted.node("welcome").pre_actions[0].text == "שלום"
    with pytest.raises(ValueError, match="mismatch"):
        adapt_retained_voice_flow(identifier, 4, frozen.model_dump(mode="json"))


async def test_adapter_executes_retained_pipecat_binder_without_provider() -> None:
    # Heavy voice tooling is optional in the lightweight control-api image.
    pytest.importorskip("oron_agent")
    from oron_agent.flows.binder import bind_flow
    from oron_agent.flows.runtime import HandlerContext, HandlerRegistry, HandlerResult

    identifier = uuid4()
    spec = expand(
        Composition.model_validate(
            {
                "flow": {"id": str(identifier), "version": 1, "language": "he"},
                "steps": [
                    {"id": "welcome", "use": "inform", "say": "שלום"},
                    {"id": "done", "use": "announce", "say": "להתראות"},
                ],
            }
        )
    )

    async def goto(context: HandlerContext) -> HandlerResult:
        return HandlerResult(route=context.config["route"])

    class Manager:
        def __init__(self) -> None:
            self.state = {}

    bound = bind_flow(
        adapt_retained_voice_flow(identifier, 1, spec.model_dump(mode="json")),
        handlers=HandlerRegistry(handlers={"goto": goto}),
    )
    initial = bound.initial_node()
    assert initial["pre_actions"][0]["text"] == "שלום"
    _, target = await initial["functions"][0].handler({}, Manager())
    assert target["name"] == "done"
    assert target["post_actions"] == [{"type": "end_conversation"}]
