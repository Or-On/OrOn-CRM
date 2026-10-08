"""Tenant-scoped adapters preserve authoritative session identity and receipts."""

import json
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from dispatcher_runtime.persistence import AgentPostgresSessions, PostgresVoiceRuntime
from oron_common import CallContext, Direction


def _context() -> CallContext:
    return CallContext(
        call_id="intake",
        direction=Direction.INBOUND,
        tenant_id=uuid4(),
        flow_id=uuid4(),
        from_number="+972502345678",
    )


def _runtime():
    runtime = object.__new__(PostgresVoiceRuntime)
    database = MagicMock()
    database.execute = AsyncMock(return_value=MagicMock())
    database.get = AsyncMock(return_value=object())
    transaction = MagicMock()
    transaction.__aenter__.return_value = None
    transaction.__aexit__.return_value = None
    database.begin.return_value = transaction
    sessionmaker = MagicMock()
    sessionmaker.return_value.__aenter__.return_value = database
    sessionmaker.return_value.__aexit__.return_value = None
    runtime._sessionmaker = sessionmaker
    return runtime, database, transaction


@pytest.mark.asyncio
async def test_service_capture_uses_session_identity_and_returns_only_after_commit() -> None:
    runtime, database, transaction = _runtime()
    context = _context()
    receipt = {"intakeId": str(uuid4()), "status": "collecting", "missingFields": ["storeName"]}
    database.execute.return_value.scalar_one.return_value = receipt
    with patch("dispatcher_runtime.persistence.set_tenant", new=AsyncMock()) as scope:
        result = await runtime.capture_service_intake(
            context, fields={"exactFailure": "לא מדפיס"}, confirmed=False
        )
    assert result == receipt
    scope.assert_awaited_once_with(database, str(context.tenant_id))
    statement, parameters = database.execute.await_args.args
    assert "service.capture_service_intake" in str(statement)
    assert parameters["session_id"] == str(context.session_id)
    assert json.loads(parameters["fields"]) == {"exactFailure": "לא מדפיס"}
    assert "phone" not in parameters and "contact_id" not in parameters
    transaction.__aexit__.assert_awaited_once()
    transaction.__aexit__.side_effect = RuntimeError("commit failed")
    with (
        patch("dispatcher_runtime.persistence.set_tenant", new=AsyncMock()),
        pytest.raises(RuntimeError, match="commit failed"),
    ):
        await runtime.capture_service_intake(context, fields={}, confirmed=True)


@pytest.mark.asyncio
async def test_photo_request_is_a_database_job_not_a_direct_provider_call() -> None:
    runtime, database, _ = _runtime()
    context = _context()
    receipt = {"status": "queued", "jobId": str(uuid4()), "intakeId": str(uuid4())}
    database.execute.return_value.scalar_one.return_value = receipt
    with patch("dispatcher_runtime.persistence.set_tenant", new=AsyncMock()) as scope:
        result = await AgentPostgresSessions(runtime).request_service_photos(
            context, message="Please reply with a photo of the error."
        )
    assert result == receipt
    scope.assert_awaited_once_with(database, str(context.tenant_id))
    statement, parameters = database.execute.await_args.args
    assert "service.request_voice_intake_photos" in str(statement)
    assert parameters == {
        "session_id": str(context.session_id),
        "message": "Please reply with a photo of the error.",
    }


@pytest.mark.asyncio
async def test_voice_context_is_loaded_under_tenant_scope() -> None:
    runtime, database, _ = _runtime()
    context = _context()
    expected = {"policy": {"photoPolicy": "optional"}, "knownFields": {"storeName": "Branch"}}
    database.execute.return_value.scalar_one.return_value = expected
    with patch("dispatcher_runtime.persistence.set_tenant", new=AsyncMock()) as scope:
        assert await AgentPostgresSessions(runtime).get_service_intake_context(context) == expected
    scope.assert_awaited_once_with(database, str(context.tenant_id))
    assert "service.voice_intake_context" in str(database.execute.await_args.args[0])


@pytest.mark.asyncio
@pytest.mark.parametrize("governed", [False, True])
async def test_voice_resolution_rejects_unapproved_retained_flow_fallback(governed) -> None:
    runtime, database, _ = _runtime()
    context = _context()
    candidates, governance = MagicMock(), MagicMock()
    candidates.mappings.return_value.all.return_value = []
    governance.scalar_one.return_value = governed
    database.execute.side_effect = [candidates, governance]
    with patch("dispatcher_runtime.persistence.set_tenant", new=AsyncMock()):
        if governed:
            with pytest.raises(ValueError, match="published voice agent binding is unavailable"):
                await runtime.get_voice_configuration(context.flow_id, tenant_id=context.tenant_id)
        else:
            assert (
                await runtime.get_voice_configuration(context.flow_id, tenant_id=context.tenant_id)
                == {}
            )
    assert "approved_flow_for_channel(flow.id,agent.id,'voice')" in str(
        database.execute.await_args_list[0].args[0]
    )


@pytest.mark.asyncio
async def test_voice_agent_binding_is_immutable_and_session_serialized() -> None:
    runtime, database, _ = _runtime()
    context, agent_id = _context(), uuid4()
    existing = MagicMock()
    existing.scalar_one_or_none.return_value = None
    identity = MagicMock()
    identity_id = uuid4()
    identity.scalar_one_or_none.return_value = identity_id
    sequence = MagicMock()
    sequence.scalar_one.return_value = 7
    database.execute.side_effect = [existing, identity, sequence]
    with patch("dispatcher_runtime.persistence.set_tenant", new=AsyncMock()):
        await runtime.pin_voice_agent(context, agent_id)
    database.get.assert_awaited_once()
    assert database.get.await_args.kwargs["with_for_update"] is True
    event = database.add.call_args.args[0]
    assert event.event_type == "voice.agent.binding.v1"
    assert event.payload == {
        "agent_version_id": str(agent_id),
        "caller_identity_id": str(identity_id),
    }
    assert "+972502345678" not in json.dumps(event.payload)
    assert event.sequence == 7

    existing.scalar_one_or_none.return_value = str(agent_id)
    database.execute.side_effect = [existing]
    database.add.reset_mock()
    with patch("dispatcher_runtime.persistence.set_tenant", new=AsyncMock()):
        await runtime.pin_voice_agent(context, agent_id)
    database.add.assert_not_called()

    database.execute.side_effect = [existing]
    with (
        patch("dispatcher_runtime.persistence.set_tenant", new=AsyncMock()),
        pytest.raises(ValueError, match="cannot change"),
    ):
        await runtime.pin_voice_agent(context, uuid4())


@pytest.mark.asyncio
async def test_exact_voice_flow_binding_records_only_server_loaded_version() -> None:
    runtime, database, _ = _runtime()
    context, agent_id = _context(), uuid4()
    existing, identity, sequence = MagicMock(), MagicMock(), MagicMock()
    existing.scalar_one_or_none.return_value = None
    identity.scalar_one_or_none.return_value = None
    sequence.scalar_one.return_value = 7
    database.execute.side_effect = [existing, identity, sequence]
    with patch("dispatcher_runtime.persistence.set_tenant", new=AsyncMock()):
        await runtime.pin_voice_agent(context, agent_id, compiled_flow_version=3)
    events = [call.args[0] for call in database.add.call_args_list]
    assert [event.event_type for event in events] == [
        "voice.agent.binding.v1",
        "voice.flow.binding.v1",
    ]
    assert events[1].sequence == 8
    assert events[1].payload == {
        "compiled_flow_id": str(context.flow_id),
        "compiled_flow_version": 3,
        "agent_version_id": str(agent_id),
    }


@pytest.mark.asyncio
async def test_retained_voice_flow_cannot_change_and_legacy_proof_is_never_backfilled() -> None:
    runtime, database, _ = _runtime()
    context, agent_id = _context(), uuid4()
    existing, retained = MagicMock(), MagicMock()
    existing.scalar_one_or_none.return_value = str(agent_id)
    retained.scalar_one_or_none.return_value = {
        "compiled_flow_id": str(context.flow_id),
        "compiled_flow_version": 2,
        "agent_version_id": str(agent_id),
    }
    database.execute.side_effect = [existing, retained]
    with (
        patch("dispatcher_runtime.persistence.set_tenant", new=AsyncMock()),
        pytest.raises(ValueError, match="flow binding cannot change"),
    ):
        await runtime.pin_voice_agent(context, agent_id, compiled_flow_version=3)
    database.add.assert_not_called()
    retained.scalar_one_or_none.return_value = None
    database.execute.side_effect = [existing, retained]
    with patch("dispatcher_runtime.persistence.set_tenant", new=AsyncMock()):
        await runtime.pin_voice_agent(context, agent_id, compiled_flow_version=3)
    database.add.assert_not_called()


@pytest.mark.parametrize("trigger", ["voice.inbound", "voice.outbound_assignment"])
async def test_voice_admission_selects_explicit_trigger_not_optional_agent_pin(trigger):
    runtime, database, _ = _runtime()
    context = _context()
    candidates, governance = MagicMock(), MagicMock()
    candidates.mappings.return_value.all.return_value = []
    governance.scalar_one.return_value = True
    database.execute.side_effect = [candidates, governance]
    with (
        patch("dispatcher_runtime.persistence.set_tenant", new=AsyncMock()),
        pytest.raises(ValueError, match="binding is unavailable"),
    ):
        await runtime.get_voice_configuration(
            context.flow_id,
            tenant_id=context.tenant_id,
            agent_version_id=uuid4(),
            trigger=trigger,
        )
    call = database.execute.await_args_list[0]
    assert call.args[1]["trigger"] == trigger
    assert "process.trigger_key = :trigger" in str(call.args[0])
    assert "THEN 'voice.inbound'" not in str(call.args[0])
