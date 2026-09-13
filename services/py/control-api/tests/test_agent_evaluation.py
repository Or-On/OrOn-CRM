"""Offline model selectors are revalidated; no raw model output or actions escape."""

import asyncio
import json
from uuid import uuid4

import pytest
from control_api.agent_evaluation import AgentEvaluationService, AgentProviderEvaluationRequest
from control_api.auth import ServicePrincipal
from fastapi import HTTPException
from oron_agent.agent_evaluation import GeneratedEvaluation
from pydantic import ValidationError


class Store:
    def __init__(self, actor):
        self.actor = actor
        self.audit = []
        self.available = True
        self.loads = 0
        self.document = {
            "tenantId": str(actor.tenant_id),
            "sourceId": str(uuid4()),
            "documentId": str(uuid4()),
            "version": 1,
            "facts": [{"factKey": "opening.hours", "value": "Open from 09:00 to 17:00."}],
        }
        self.context = {
            "system_prompt": "Fictional assistant",
            "quality": {"language": "en"},
            "knowledge": [self.document],
        }

    async def load_evaluation_context(self, actor, agent, version):
        self.loads += 1
        return self.context if self.available else None

    async def audit_evaluation(self, actor, version, request, status):
        self.audit.append((str(request), status))


class Provider:
    def __init__(self, store):
        self.store = store
        self.selection = None
        self.revoke = False
        self.calls = 0
        self.block = None

    async def evaluate(self, text, context, tenant_id, *, confirmed):
        assert confirmed is True
        self.calls += 1
        if self.block:
            await self.block.wait()
        document = self.store.document
        selection = self.selection or json.dumps(
            {
                "kind": "fact",
                "sourceId": document["sourceId"],
                "documentId": document["documentId"],
                "version": 1,
                "factKey": "opening.hours",
            }
        )
        if self.revoke:
            self.store.context = {**context, "knowledge": []}
        return GeneratedEvaluation(selection, "injected-fixture", "fixture-model")


def fixture():
    actor = ServicePrincipal(
        user_id=uuid4(),
        tenant_id=uuid4(),
        session_id=uuid4(),
        role="admin",
        capability="orchestration:write",
    )
    command = AgentProviderEvaluationRequest(
        agent_id=uuid4(), version_id=uuid4(), text="When are you open?", confirmed=True
    )
    store = Store(actor)
    provider = Provider(store)
    return actor, command, store, provider


async def test_actual_selector_is_rendered_with_fresh_provenance_and_unknown_cost():
    actor, command, store, provider = fixture()
    result = await AgentEvaluationService(store, enabled=True, provider=provider).evaluate(
        actor, command
    )
    assert result.response == "Open from 09:00 to 17:00." and result.decision == "approved_fact"
    assert result.sources[0].document_id.hex == store.document["documentId"].replace("-", "")
    assert (
        result.cost_usd is None
        and result.recognized_text is None
        and result.actions_executed is False
    )
    assert result.model_ms >= 0 and result.validation_ms >= 0 and store.loads == 2
    assert [row[1] for row in store.audit] == ["started", "succeeded"]
    assert "selection" not in result.model_dump() and "Open" not in str(store.audit)


@pytest.mark.parametrize("mode", ["revoked", "injected", "conflicting"])
async def test_stale_conflicting_and_raw_injection_never_return_model_claim(mode):
    actor, command, store, provider = fixture()
    if mode == "revoked":
        provider.revoke = True
    elif mode == "injected":
        provider.selection = "private reasoning: I have refunded your payment secret-token"
    else:
        store.context["knowledge"].append(
            {
                **store.document,
                "documentId": str(uuid4()),
                "facts": [{"factKey": "opening.hours", "value": "Closed all day."}],
            }
        )
    result = await AgentEvaluationService(store, enabled=True, provider=provider).evaluate(
        actor, command
    )
    assert result.decision == "unverified" and not result.sources
    assert "private reasoning" not in result.model_dump_json() and "refunded" not in result.response


async def test_disabled_wrong_version_and_timeout_are_non_spending_or_bounded():
    actor, command, store, provider = fixture()
    for enabled, available, status in [(False, True, 503), (True, False, 404)]:
        store.available = available
        with pytest.raises(HTTPException) as error:
            await AgentEvaluationService(store, enabled=enabled, provider=provider).evaluate(
                actor, command
            )
        assert error.value.status_code == status
    assert provider.calls == 0
    store.available = True
    provider.block = asyncio.Event()
    with pytest.raises(HTTPException) as error:
        await AgentEvaluationService(
            store, enabled=True, provider=provider, timeout_seconds=0.01
        ).evaluate(actor, command)
    assert error.value.status_code == 504


def test_explicit_request_bounds_and_confirmation():
    _, command, _, _ = fixture()
    for changed in ({"confirmed": False}, {"text": "x" * 1001}, {"api_key": "forbidden"}):
        with pytest.raises(ValidationError):
            AgentProviderEvaluationRequest.model_validate({**command.model_dump(), **changed})
