"""Exercise control-api liveness and PostgreSQL-backed readiness in-process."""

from __future__ import annotations

import asyncio

import httpx
from control_api.app import create_app


async def check() -> None:
    app = create_app()
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://control-api") as client:
            liveness = await client.get("/health/live")
            readiness = await client.get("/health/ready")
    if liveness.status_code != 200:
        raise RuntimeError(f"control-api liveness failed with HTTP {liveness.status_code}")
    if readiness.status_code != 200:
        raise RuntimeError(f"control-api readiness failed with HTTP {readiness.status_code}")
    print("control-api liveness and PostgreSQL readiness passed")


if __name__ == "__main__":
    asyncio.run(check())
