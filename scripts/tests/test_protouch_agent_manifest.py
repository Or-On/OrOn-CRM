"""ProTouch draft has an executable agent contract without provider secrets."""

import json
import re
from pathlib import Path

MANIFEST = Path(__file__).resolve().parents[2] / "infra/tenant-configurations/protouch.agent.json"


def test_protouch_agent_manifest_keeps_provider_activation_off_and_secrets_out():
    content = MANIFEST.read_text(encoding="utf-8")
    config = json.loads(content)
    agent = config["agent"]
    assert config["tenantSlugHint"] == "protouch"
    assert agent["locale"] == "he"
    assert set(agent["channels"]) == {"voice", "whatsapp"}
    assert set(agent["toolPermissions"]) == {"service.intake"}
    assert "פרו טאץ'" in agent["systemPrompt"]
    assert "Or-On" not in agent["systemPrompt"]
    assert len(agent["systemPrompt"]) <= 16_000
    assert config["inheritSharedRuntime"] == ["LLM", "STT", "TTS"]
    assert not config["activation"]["realWhatsApp"]
    assert not config["activation"]["realTelephony"]
    wa = config["providerReferences"]["whatsapp"]
    assert all(wa[key].isdigit() for key in ("businessId", "wabaId", "phoneNumberId"))
    assert re.fullmatch(r"v[0-9]+\.0", wa["graphApiVersion"])
    assert re.fullmatch(r"\+[1-9][0-9]{7,14}", config["providerReferences"]["voice"]["callerId"])
    assert not any(
        key in content.upper()
        for key in ("AUTH_TOKEN", "ACCESS_TOKEN", "APP_SECRET", "SIP_PASSWORD", "API_KEY")
    )
    assert "twilioAccountSid" not in content
    assert re.search(r"\bAC[0-9a-fA-F]{32}\b", content) is None
