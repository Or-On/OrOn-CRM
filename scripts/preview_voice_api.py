"""Owned loopback Voice read preview: real repository/router, no simulation worker.

Not an application entrypoint. The normal control-api lifespan starts a worker;
this visual-test factory intentionally does not. Authentication and tenant RLS
remain the existing control-api contracts.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

import asyncpg
from control_api.auth import ServiceAssertionVerifier
from control_api.voice import PostgresVoiceRepository, create_voice_router
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from scripts.preview_ui_fixtures import validate_fixture_database


def create_app() -> FastAPI:
    database_url = os.environ["VOICE_DATABASE_URL"]
    validate_fixture_database(database_url, os.environ["PREVIEW_DATABASE_NAME"])
    if any(
        os.environ.get(key, "false").lower() != "false"
        for key in (
            "ENABLE_REAL_WHATSAPP",
            "ENABLE_REAL_TELEPHONY",
            "ENABLE_REAL_VOICE_PROVIDERS",
        )
    ):
        raise ValueError("Visual preview requires all real providers disabled")
    repository = PostgresVoiceRepository(database_url)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        try:
            yield
        finally:
            await repository.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
    app.include_router(
        create_voice_router(repository, ServiceAssertionVerifier(os.environ["AUTH_SERVICE_SECRET"]))
    )

    @app.get("/health/live")
    async def live():
        return {"status": "alive", "service": "control-api", "version": "0.1.0"}

    @app.get("/health/ready")
    async def ready():
        connection = None
        try:
            connection = await asyncpg.connect(database_url, timeout=3)
            observed = await connection.fetchval("SELECT 1") == 1
        except OSError, asyncpg.PostgresError, TimeoutError:
            observed = False
        finally:
            if connection is not None:
                await connection.close()
        return JSONResponse(
            {
                "status": "ready" if observed else "not_ready",
                "service": "control-api",
                "dependencies": {"postgres": "ready" if observed else "unavailable"},
            },
            status_code=200 if observed else 503,
        )

    return app
