"""The optional Voice visual-test service never targets ordinary databases."""

from __future__ import annotations

import asyncio

import pytest

from scripts import preview_voice_api


def environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VOICE_DATABASE_URL", "postgresql://localhost/oron_ui_preview_test")
    monkeypatch.setenv("PREVIEW_DATABASE_NAME", "oron_ui_preview_test")
    monkeypatch.setenv("AUTH_SERVICE_SECRET", "fictional-preview-test-secret-never-used-live")
    for key in (
        "ENABLE_REAL_WHATSAPP",
        "ENABLE_REAL_TELEPHONY",
        "ENABLE_REAL_VOICE_PROVIDERS",
    ):
        monkeypatch.setenv(key, "false")


def test_preview_refuses_non_owned_database(monkeypatch: pytest.MonkeyPatch) -> None:
    environment(monkeypatch)
    monkeypatch.setenv("VOICE_DATABASE_URL", "postgresql://localhost/ordinary_developer_database")
    with pytest.raises(ValueError, match="owned localhost preview database"):
        preview_voice_api.create_app()


def test_preview_refuses_enabled_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    environment(monkeypatch)
    monkeypatch.setenv("ENABLE_REAL_TELEPHONY", "true")
    with pytest.raises(ValueError, match="all real providers disabled"):
        preview_voice_api.create_app()


def test_preview_lifespan_only_closes_owned_repository(monkeypatch: pytest.MonkeyPatch) -> None:
    environment(monkeypatch)
    closed: list[bool] = []

    class FakeRepository:
        def __init__(self, _: str):
            pass

        async def close(self) -> None:
            closed.append(True)

    monkeypatch.setattr(preview_voice_api, "PostgresVoiceRepository", FakeRepository)
    app = preview_voice_api.create_app()

    async def exercise() -> None:
        before = set(asyncio.all_tasks())
        async with app.router.lifespan_context(app):
            assert set(asyncio.all_tasks()) == before
            assert not closed

    asyncio.run(exercise())
    assert closed == [True]
