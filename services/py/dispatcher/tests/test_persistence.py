from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from dispatcher_runtime.main import _livekit_api_url
from dispatcher_runtime.persistence import (
    PostgresVoiceRuntime,
    VoicePersistenceSettings,
    _async_database_url,
    _call_configuration_event,
)
from oron_common import CallContext, Direction
from oron_flows import FlowSpec


def test_livekit_websocket_url_is_normalized_for_control_api() -> None:
    assert _livekit_api_url("wss://example.livekit.cloud") == "https://example.livekit.cloud"
    assert _livekit_api_url("ws://127.0.0.1:7880") == "http://127.0.0.1:7880"


def test_postgres_url_is_normalized_for_async_sqlalchemy() -> None:
    assert _async_database_url("postgresql://host/platform") == (
        "postgresql+asyncpg://host/platform"
    )
    assert _async_database_url("postgresql+asyncpg://host/platform") == (
        "postgresql+asyncpg://host/platform"
    )


def test_voice_persistence_keys_require_32_bytes() -> None:
    settings = VoicePersistenceSettings(
        VOICE_DATABASE_URL="postgresql+asyncpg://user:pass@localhost/platform",
        FIELD_CIPHER_LOCAL_KEY="dG9vLXNob3J0",
        BLIND_INDEX_KEY="dG9vLXNob3J0",
        _env_file=None,
    )
    with pytest.raises(ValueError, match="exactly 32 bytes"):
        settings.cipher_key()
    with pytest.raises(ValueError, match="at least 32 bytes"):
        settings.index_key()


def test_outbound_call_persists_the_operator_selected_address_form() -> None:
    context = CallContext(
        call_id="call-1",
        direction=Direction.OUTBOUND,
        flow_id=UUID("702a2dd8-24d9-4d54-a571-89c69978d48a"),
        tenant_id=UUID("10000000-0000-4000-8000-000000000001"),
        session_id=UUID("137b35dc-b56a-5d11-bf23-5a03771f3095"),
        caller_gender="female",
    )

    event = _call_configuration_event(context)

    assert event is not None
    assert event.event_type == "voice.call.configuration.v1"
    assert event.sequence == 0
    assert event.payload == {
        "caller_address_form": "female",
        "source": "operator_selection",
    }


def test_call_configuration_event_omits_unconfigured_inbound_form() -> None:
    context = CallContext(
        call_id="call-1",
        direction=Direction.INBOUND,
        flow_id=UUID("702a2dd8-24d9-4d54-a571-89c69978d48a"),
        tenant_id=UUID("10000000-0000-4000-8000-000000000001"),
    )

    assert _call_configuration_event(context) is None


@pytest.mark.asyncio
async def test_published_agent_prompt_is_applied_to_flow_and_node_roles() -> None:
    flow_id = UUID("702a2dd8-24d9-4d54-a571-89c69978d48a")
    tenant_id = UUID("10000000-0000-4000-8000-000000000001")
    spec = FlowSpec.model_validate(
        {
            "id": str(flow_id),
            "version": 1,
            "entry": "start",
            "language": "he",
            "role_message": "Retained flow persona",
            "nodes": [
                {
                    "name": "start",
                    "role_message": "Ask the qualification question",
                }
            ],
        }
    )
    runtime = object.__new__(PostgresVoiceRuntime)
    runtime._flows = AsyncMock()  # pyrefly: ignore[bad-assignment]
    runtime._flows.load_latest.return_value = spec
    runtime._published_agent_prompt = AsyncMock(  # pyrefly: ignore[bad-assignment]
        return_value="You are the published agent"
    )

    resolved = await runtime.get_flow(flow_id, tenant_id=tenant_id)

    assert resolved is not None
    assert resolved.persona_gender == "neutral"
    assert resolved.role_message.startswith(
        "You are the published agent\n\nNatural live-conversation policy"
    )
    assert "Retained flow persona" not in resolved.role_message
    assert "Every\n  completed user turn is part of a real conversation" in resolved.role_message
    assert "greetings, small talk, jokes, acknowledgements" in resolved.role_message
    assert "Address every meaningful part of a turn" in resolved.role_message
    assert "Use the language the caller is currently communicating in" in resolved.role_message
    assert "Never use technical self-reference" in resolved.role_message
    assert "Do not guess the caller's gender" in resolved.role_message
    assert "never alternate masculine and" in resolved.role_message
    assert "usually one to three sentences" in resolved.role_message
    assert "Never join an answer and its follow-up question" in resolved.role_message
    assert 'Do not use "אני מבינה" or "אני מבין" as automatic filler' in resolved.role_message
    assert "unless a tool shown in the" in resolved.role_message
    assert "current turn returns that exact result" in resolved.role_message
    assert "Do not lecture, cite laws or ethics" in resolved.role_message
    assert "Your structured speaking gender is neutral" in resolved.role_message
    assert resolved.nodes[0].role_message.startswith(resolved.role_message)
    assert resolved.nodes[0].role_message.endswith(
        "Voice flow node instructions:\nAsk the qualification question"
    )


@pytest.mark.asyncio
async def test_retained_flow_without_agent_still_gets_voice_safety_rules() -> None:
    flow_id = UUID("702a2dd8-24d9-4d54-a571-89c69978d48a")
    tenant_id = UUID("10000000-0000-4000-8000-000000000001")
    spec = FlowSpec.model_validate(
        {
            "id": str(flow_id),
            "version": 1,
            "entry": "start",
            "persona_gender": "male",
            "role_message": "You are Or",
            "nodes": [{"name": "start"}],
        }
    )
    runtime = object.__new__(PostgresVoiceRuntime)
    runtime._flows = AsyncMock()  # pyrefly: ignore[bad-assignment]
    runtime._flows.load_latest.return_value = spec
    runtime._published_agent_prompt = AsyncMock(return_value=None)  # pyrefly: ignore[bad-assignment]

    resolved = await runtime.get_flow(flow_id, tenant_id=tenant_id)

    assert resolved is not None
    assert resolved.persona_gender == "male"
    assert resolved.role_message.startswith("You are Or")
    assert "Never use technical self-reference" in resolved.role_message
    assert "Your structured speaking gender is male" in resolved.role_message
