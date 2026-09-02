"""Durable PostgreSQL claim ledger for signed LiveKit webhook deliveries."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Protocol

import asyncpg


@dataclass(frozen=True, slots=True)
class WebhookClaim:
    event_id: str
    should_process: bool


class WebhookLedger(Protocol):
    async def claim(
        self, *, provider_event_id: str, event_type: str, payload: dict[str, object]
    ) -> WebhookClaim: ...

    async def complete(self, event_id: str) -> None: ...

    async def fail(self, event_id: str) -> None: ...

    async def ready(self) -> bool: ...

    async def close(self) -> None: ...


class PostgresWebhookLedger:
    """Claim each LiveKit event once; failed handlers remain retryable."""

    def __init__(
        self,
        database_url: str,
        *,
        provider_account_id: str = "default",
        pool: asyncpg.Pool | None = None,
        lease_seconds: int = 300,
    ) -> None:
        if not 1 <= lease_seconds <= 3600:
            raise ValueError("webhook claim lease must be between 1 and 3600 seconds")
        self._database_url = database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
        self._provider_account_id = provider_account_id
        self._pool = pool
        self._owns_pool = pool is None
        self._lease_seconds = lease_seconds

    async def _get_pool(self) -> asyncpg.Pool:
        if self._pool is None:
            self._pool = await asyncpg.create_pool(self._database_url, min_size=1, max_size=4)
        return self._pool

    async def claim(
        self, *, provider_event_id: str, event_type: str, payload: dict[str, object]
    ) -> WebhookClaim:
        pool = await self._get_pool()
        async with pool.acquire() as connection, connection.transaction():
            inserted_id = await connection.fetchval(
                """
                INSERT INTO ops.inbound_events
                  (tenant_id, provider, provider_account_id, provider_event_id,
                   event_type, payload)
                VALUES (NULL, 'livekit', $1, $2, $3, $4::jsonb)
                ON CONFLICT (provider, provider_account_id, provider_event_id) DO NOTHING
                RETURNING id
                """,
                self._provider_account_id,
                provider_event_id,
                event_type[:200],
                json.dumps(payload, separators=(",", ":"), sort_keys=True),
            )
            claimed_id = await connection.fetchval(
                """
                UPDATE ops.inbound_events
                SET status = 'processing', attempts = attempts + 1,
                    locked_at = CURRENT_TIMESTAMP, locked_by = 'dispatcher',
                    last_error_safe = NULL
                WHERE provider = 'livekit'
                  AND provider_account_id = $1
                  AND provider_event_id = $2
                  AND (
                    (status IN ('received', 'failed') AND available_at <= CURRENT_TIMESTAMP)
                    OR (
                      status = 'processing'
                      AND locked_at < CURRENT_TIMESTAMP
                        - make_interval(secs => GREATEST(1, $3::integer))
                    )
                  )
                  AND attempts < max_attempts
                RETURNING id
                """,
                self._provider_account_id,
                provider_event_id,
                self._lease_seconds,
            )
            event_id = claimed_id or inserted_id
            if event_id is None:
                event_id = await connection.fetchval(
                    """
                    SELECT id FROM ops.inbound_events
                    WHERE provider = 'livekit'
                      AND provider_account_id = $1
                      AND provider_event_id = $2
                    """,
                    self._provider_account_id,
                    provider_event_id,
                )
            if event_id is None:
                raise RuntimeError("webhook delivery could not be persisted")
            return WebhookClaim(event_id=str(event_id), should_process=claimed_id is not None)

    async def complete(self, event_id: str) -> None:
        pool = await self._get_pool()
        async with pool.acquire() as connection:
            result = await connection.execute(
                """
                UPDATE ops.inbound_events
                SET status = 'processed', processed_at = CURRENT_TIMESTAMP,
                    locked_at = NULL, locked_by = NULL, last_error_safe = NULL
                WHERE id = $1::uuid AND status = 'processing' AND locked_by = 'dispatcher'
                """,
                event_id,
            )
        if result != "UPDATE 1":
            raise RuntimeError("webhook completion lost its durable claim")

    async def fail(self, event_id: str) -> None:
        pool = await self._get_pool()
        async with pool.acquire() as connection:
            await connection.execute(
                """
                UPDATE ops.inbound_events
                SET status = 'failed', available_at = CURRENT_TIMESTAMP,
                    locked_at = NULL, locked_by = NULL,
                    last_error_safe = 'dispatcher_handler_failed'
                WHERE id = $1::uuid AND status = 'processing' AND locked_by = 'dispatcher'
                """,
                event_id,
            )

    async def ready(self) -> bool:
        try:
            pool = await self._get_pool()
            async with pool.acquire() as connection:
                return await connection.fetchval("SELECT 1") == 1
        except OSError, asyncpg.PostgresError:
            return False

    async def close(self) -> None:
        if self._pool is not None and self._owns_pool:
            await self._pool.close()
            self._pool = None
