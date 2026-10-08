from uuid import uuid4

from control_api.auth import ServicePrincipal
from control_api.effective_prompt import EffectivePromptResult, create_effective_prompt_router
from fastapi import FastAPI
from fastapi.testclient import TestClient
from oron_common.voice_instructions import TenantSupportProfile, compose_voice_instruction_snapshot


class Verifier:
    actor = ServicePrincipal(
        user_id=uuid4(),
        tenant_id=uuid4(),
        session_id=uuid4(),
        role="admin",
        capability="orchestration:read",
    )

    def verify(self, token):
        return self.actor


class Repository:
    calls = 0
    available = True

    async def inspect(self, principal, agent, version, flow, flow_version, node):
        self.calls += 1
        if not self.available:
            return None
        snapshot = compose_voice_instruction_snapshot(
            TenantSupportProfile(displayName="Fictional", supportDisplayName="Fictional"),
            agent_prompt="Explain services",
            persona_gender="female",
            node_instruction=node,
        )
        return EffectivePromptResult(**snapshot, exclusions=["Empty context"])


def test_authenticated_read_only_preview_uses_shared_runtime_composer():
    app, repository, verifier = FastAPI(), Repository(), Verifier()
    app.include_router(create_effective_prompt_router(repository, verifier))
    path = f"/api/v1/orchestration/agents/{uuid4()}/versions/{uuid4()}/effective-prompt"
    with TestClient(app) as client:
        assert client.get(path).status_code == 401
        assert repository.calls == 0
        verifier.actor.capability = "voice:write"
        assert client.get(path, headers={"authorization": "Bearer synthetic"}).status_code == 403
        assert repository.calls == 0
        verifier.actor.capability = "orchestration:read"
        response = client.get(path, headers={"authorization": "Bearer synthetic"})
        expected = compose_voice_instruction_snapshot(
            TenantSupportProfile(displayName="Fictional", supportDisplayName="Fictional"),
            agent_prompt="Explain services",
            persona_gender="female",
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert {key: response.json()[key] for key in expected} == expected
        assert (
            client.get(
                path + f"?flow_id={uuid4()}", headers={"authorization": "Bearer synthetic"}
            ).status_code
            == 400
        )
        repository.available = False
        assert client.get(path, headers={"authorization": "Bearer synthetic"}).status_code == 404
