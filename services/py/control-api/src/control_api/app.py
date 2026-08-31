"""FastAPI application factory with honest liveness and PostgreSQL readiness."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal, Protocol
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from or_on_platform.config import PlatformSettings
from or_on_platform.database import create_database_probe
from or_on_platform.logging import configure_logging
from pydantic import BaseModel


class ReadinessProbe(Protocol):
    async def is_ready(self) -> bool: ...

    async def close(self) -> None: ...


class LiveStatus(BaseModel):
    status: Literal["alive"] = "alive"
    service: str
    version: str = "0.1.0"


class DependencyStatus(BaseModel):
    postgres: Literal["ready", "unavailable"]


class ReadyStatus(BaseModel):
    status: Literal["ready", "not_ready"]
    service: str
    dependencies: DependencyStatus


def create_app(
    *,
    settings: PlatformSettings | None = None,
    database_probe: ReadinessProbe | None = None,
) -> FastAPI:
    """Create a process-owned app; tests inject dependencies without module globals."""

    resolved_settings = settings or PlatformSettings.load(
        require_database=True, service="control-api"
    )
    resolved_probe = database_probe
    if resolved_probe is None:
        if resolved_settings.database_url is None:
            raise RuntimeError("control-api requires DATABASE_URL")
        resolved_probe = create_database_probe(str(resolved_settings.database_url))

    logger = configure_logging(
        service="control-api",
        environment=resolved_settings.environment,
        level=resolved_settings.log_level,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        logger.info("service_started", extra={"fields": resolved_settings.diagnostics()})
        try:
            yield
        finally:
            await resolved_probe.close()
            logger.info("service_stopped")

    app = FastAPI(
        title="Or-On Platform Control API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/docs" if resolved_settings.environment != "production" else None,
        redoc_url=None,
    )

    @app.middleware("http")
    async def correlation_id(request: Request, call_next):  # type: ignore[no-untyped-def]
        request_id = request.headers.get("x-request-id", str(uuid4()))
        response = await call_next(request)
        response.headers["x-request-id"] = request_id
        return response

    @app.get(
        "/health/live",
        response_model=LiveStatus,
        operation_id="get_liveness",
        tags=["system"],
    )
    async def liveness() -> LiveStatus:
        return LiveStatus(service="control-api")

    @app.get(
        "/health/ready",
        response_model=ReadyStatus,
        responses={503: {"model": ReadyStatus}},
        operation_id="get_readiness",
        tags=["system"],
    )
    async def readiness() -> ReadyStatus | JSONResponse:
        postgres_ready = await resolved_probe.is_ready()
        status = ReadyStatus(
            status="ready" if postgres_ready else "not_ready",
            service="control-api",
            dependencies=DependencyStatus(postgres="ready" if postgres_ready else "unavailable"),
        )
        if not postgres_ready:
            return JSONResponse(status_code=503, content=status.model_dump())
        return status

    return app
