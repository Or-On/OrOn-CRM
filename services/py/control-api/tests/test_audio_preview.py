"""Offline injected TTS preview protection; no real provider credentials or requests."""

import asyncio
from dataclasses import dataclass
from uuid import uuid4

import pytest
from control_api.app import create_app
from control_api.audio_preview import AudioPreviewRequest, AudioPreviewService
from control_api.auth import ServicePrincipal
from fastapi import HTTPException
from fastapi.testclient import TestClient
from or_on_platform.config import PlatformSettings
from pydantic import ValidationError


def principal():
    return ServicePrincipal(
        user_id=uuid4(),
        tenant_id=uuid4(),
        session_id=uuid4(),
        role="admin",
        capability="orchestration:write",
    )


def command(**changes):
    return AudioPreviewRequest(
        agent_id=uuid4(), version_id=uuid4(), text="שלום", confirmed=True, **changes
    )


class Store:
    def __init__(self):
        self.available = True
        self.audit = []
        self.in_transaction = False

    async def load_audio_preview_quality(self, actor, agent, version):
        assert not self.in_transaction
        return {"schemaVersion": "1.0"} if self.available else None

    async def audit_audio_preview(self, actor, version, request, status):
        self.audit.append((actor.user_id, version, request, status))


@dataclass
class Audio:
    audio: bytes = b"RIFF" + b"\0" * 44
    provider: str = "injected-fixture"
    model: str = "test-only"
    voice: str = "fixture"
    duration_seconds: float = 0.01
    canonical_text: str = "שלום"
    speech_normalized_text: str = "שלום"


class Provider:
    def __init__(self, store):
        self.store = store
        self.calls = 0
        self.block = None
        self.error = False

    async def synthesize(self, text, quality, *, confirmed):
        assert confirmed is True and not self.store.in_transaction
        self.calls += 1
        if self.block is not None:
            await self.block.wait()
        if self.error:
            raise RuntimeError("private 0501234567 secret-token submitted text")
        return Audio()


async def test_explicit_published_preview_audits_identifiers_and_no_text():
    store = Store()
    provider = Provider(store)
    service = AudioPreviewService(store, enabled=True, provider=provider)
    request = command()
    actor = principal()
    result = await service.preview(actor, request)
    assert result.version_id == request.version_id
    assert result.evaluation_kind == "paid_tts_preview" and result.expires_in_seconds == 60
    assert [row[3] for row in store.audit] == ["started", "succeeded"]
    assert request.text not in str(store.audit)
    assert provider.calls == 1


async def test_disabled_and_cross_tenant_unavailable_never_invoke_provider():
    store = Store()
    provider = Provider(store)
    for enabled, available, expected in [(False, True, 503), (True, False, 404)]:
        store.available = available
        with pytest.raises(HTTPException) as error:
            await AudioPreviewService(store, enabled=enabled, provider=provider).preview(
                principal(), command()
            )
        assert error.value.status_code == expected
    assert provider.calls == 0


async def test_timeout_and_provider_failure_are_redacted_and_release_admission():
    store = Store()
    provider = Provider(store)
    provider.block = asyncio.Event()
    service = AudioPreviewService(store, enabled=True, provider=provider, timeout_seconds=0.01)
    actor = principal()
    with pytest.raises(HTTPException) as error:
        await service.preview(actor, command())
    assert error.value.status_code == 504
    provider.block = None
    provider.error = True
    with pytest.raises(HTTPException) as error:
        await service.preview(actor, command())
    assert error.value.detail == "audio preview is unavailable"
    assert [row[3] for row in store.audit] == ["started", "failed", "started", "failed"]


async def test_caps_one_per_tenant_two_per_process_and_revalidates_access():
    store = Store()
    provider = Provider(store)
    provider.block = asyncio.Event()
    service = AudioPreviewService(store, enabled=True, provider=provider)
    actor = principal()
    first = asyncio.create_task(service.preview(actor, command()))
    await asyncio.sleep(0)
    with pytest.raises(HTTPException) as error:
        await service.preview(actor, command())
    assert error.value.status_code == 429
    second = asyncio.create_task(service.preview(principal(), command()))
    await asyncio.sleep(0)
    with pytest.raises(HTTPException) as error:
        await service.preview(principal(), command())
    assert error.value.status_code == 429
    store.available = False
    provider.block.set()
    results = await asyncio.gather(first, second, return_exceptions=True)
    assert all(
        isinstance(result, HTTPException) and result.status_code == 403 for result in results
    )


async def test_cancelled_preview_releases_slot_and_audits_without_content():
    store = Store()
    provider = Provider(store)
    provider.block = asyncio.Event()
    service = AudioPreviewService(store, enabled=True, provider=provider)
    actor = principal()
    task = asyncio.create_task(service.preview(actor, command()))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [row[3] for row in store.audit] == ["started", "cancelled"]
    provider.block = None
    assert (await service.preview(actor, command())).media_type == "audio/wav"


async def test_incomplete_provider_cleanup_quarantines_admission_until_restart():
    class Unclosed(RuntimeError):
        provider_work_may_continue = True

    class UnclosedProvider(Provider):
        async def synthesize(self, *args, **kwargs):
            raise Unclosed("private")

    store = Store()
    actor = principal()
    service = AudioPreviewService(store, enabled=True, provider=UnclosedProvider(store))
    with pytest.raises(HTTPException) as error:
        await service.preview(actor, command())
    assert error.value.status_code == 503
    with pytest.raises(HTTPException) as error:
        await service.preview(actor, command())
    assert error.value.status_code == 429


@pytest.mark.parametrize(
    "change",
    [
        {"confirmed": False},
        {"confirmed": 1},
        {"text": "x" * 301},
        {"text": "<speak>test</speak>"},
        {"text": "\u202etest"},
        {"api_key": "forbidden"},
    ],
)
def test_request_rejects_unconfirmed_unbounded_markup_controls_secrets(change):
    with pytest.raises(ValidationError):
        AudioPreviewRequest.model_validate(
            {
                "agent_id": str(uuid4()),
                "version_id": str(uuid4()),
                "text": "test",
                "confirmed": True,
                **change,
            }
        )


class Probe:
    async def is_ready(self):
        return True

    async def close(self):
        pass


class Verifier:
    def __init__(self):
        self.actor = principal()

    def verify(self, token):
        return self.actor


def test_route_auth_no_store_and_opaque_errors():
    store = Store()
    provider = Provider(store)
    verifier = Verifier()
    service = AudioPreviewService(store, enabled=True, provider=provider)
    app = create_app(
        settings=PlatformSettings(_env_file=None, PLATFORM_ENV="test"),
        database_probe=Probe(),
        audio_preview_service=service,
        assertion_verifier=verifier,
    )
    with TestClient(app) as client:
        body = command().model_dump(mode="json")
        url = "/api/v1/orchestration/agents/audio-preview"
        assert client.post(url, json=body).status_code == 401
        verifier.actor.capability = "voice:read"
        response = client.post(url, json=body, headers={"authorization": "Bearer fixture"})
        assert response.status_code == 403
        assert response.headers["cache-control"] == "private, no-store"
        assert provider.calls == 0
        verifier.actor.capability = "orchestration:write"
        response = client.post(url, json=body, headers={"authorization": "Bearer fixture"})
        assert response.status_code == 200 and response.json()["media_type"] == "audio/wav"
        assert response.headers["cache-control"] == "private, no-store"
