"""The reviewed transport shell is executable and does not reintroduce a questionnaire."""

import json
from pathlib import Path

from oron_flows import FlowSpec


def test_shared_agent_flow_uses_published_business_policy():
    root = Path(__file__).resolve().parents[4]
    data = json.loads(
        (root / "infra/tenant-configurations/shared-agent.voice-flow.json").read_text(
            encoding="utf-8"
        )
    )
    spec = FlowSpec.model_validate(data)
    assert spec.reachable_from_entry() == {"conversation", "end"}
    assert spec.node("end").is_terminal
    assert spec.node("conversation").respond_immediately
    assert spec.role_message is None
    assert spec.persona_gender == "female"
    assert not spec.node("conversation").pre_actions
    assert spec.node("conversation").functions[0].handler == "goto"
    assert "published agent instructions" in spec.node("conversation").task_messages[0].content
