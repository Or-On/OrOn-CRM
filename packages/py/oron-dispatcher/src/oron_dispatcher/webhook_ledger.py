"""LiveKit-only durable ingress and fresh-token claim ledger."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Protocol
from uuid import uuid4

import asyncpg

from oron_dispatcher.webhook_pump import DurableDelivery


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
    async def quarantine(self, event_id: str, reason: str) -> None: ...
    async def ready(self) -> bool: ...
    async def close(self) -> None: ...


class PostgresWebhookLedger:
    """Signature-verified ingress, durable replay and database-fenced settlement."""

    def __init__(
        self,
        database_url: str,
        *,
        provider_account_id: str = "default",
        pool: asyncpg.Pool | None = None,
        lease_seconds: int = 60,
    ) -> None:
        if not 10 <= lease_seconds <= 120:
            raise ValueError("webhook claim lease must be between 10 and 120 seconds")
        if not 1 <= len(provider_account_id) <= 200:
            raise ValueError("invalid LiveKit account binding")
        self._database_url = database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
        self._provider_account_id = provider_account_id
        self._pool = pool
        self._owns_pool = pool is None
        self._lease_seconds = lease_seconds
        self._worker = "dispatcher-" + uuid4().hex

    async def _get_pool(self) -> asyncpg.Pool:
        if self._pool is None:
            self._pool = await asyncpg.create_pool(self._database_url, min_size=1, max_size=4)
        return self._pool

    async def accept(
        self, *, provider_event_id: str, event_type: str, payload: dict[str, object]
    ) -> WebhookClaim:
        pool = await self._get_pool()
        async with pool.acquire() as connection:
            row = await connection.fetchrow(
                "SELECT * FROM ops.accept_livekit_event($1,$2,$3,$4::jsonb)",
                self._provider_account_id,
                provider_event_id,
                event_type,
                json.dumps(payload, separators=(",", ":"), sort_keys=True),
            )
        if row is None:
            raise RuntimeError("webhook accept did not persist a delivery")
        return WebhookClaim(str(row["event_id"]), not row["duplicate"])

    async def claim_pending(self, limit: int) -> list[DurableDelivery]:
        pool = await self._get_pool()
        async with pool.acquire() as connection:
            rows = await connection.fetch(
                "SELECT * FROM ops.claim_livekit_events($1,$2,$3,$4)",
                self._provider_account_id,
                self._worker,
                limit,
                self._lease_seconds,
            )
        return [
            DurableDelivery(
                str(row["id"]),
                str(row["voice_claim_token"]),
                json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"],
            )
            for row in rows
        ]

    async def renew(self, delivery: DurableDelivery) -> bool:
        pool = await self._get_pool()
        async with pool.acquire() as connection:
            return bool(
                await connection.fetchval(
                    "SELECT ops.renew_livekit_claim($1,$2::uuid,$3,$4::uuid,$5)",
                    self._provider_account_id,
                    delivery.event_id,
                    self._worker,
                    delivery.token,
                    self._lease_seconds,
                )
            )

    async def settle(self, delivery: DurableDelivery, outcome: str, reason: str | None) -> bool:
        pool = await self._get_pool()
        async with pool.acquire() as connection:
            return bool(
                await connection.fetchval(
                    "SELECT ops.settle_livekit_claim($1,$2::uuid,$3,$4::uuid,$5,$6)",
                    self._provider_account_id,
                    delivery.event_id,
                    self._worker,
                    delivery.token,
                    outcome,
                    reason,
                )
            )

    async def ready(self) -> bool:
        signatures = (
            "ops.accept_livekit_event(text,text,text,jsonb)",
            "ops.claim_livekit_events(text,text,integer,integer)",
            "ops.renew_livekit_claim(text,uuid,text,uuid,integer)",
            "ops.settle_livekit_claim(text,uuid,text,uuid,text,text)",
        )
        try:
            pool = await self._get_pool()
            async with pool.acquire() as connection:
                for signature in signatures:
                    if not await connection.fetchval(
                        "SELECT COALESCE(has_function_privilege(current_user, "
                        "to_regprocedure($1), 'EXECUTE'),false)",
                        signature,
                    ):
                        return False
            return True
        except OSError, asyncpg.PostgresError:
            return False

    async def close(self) -> None:
        if self._pool is not None and self._owns_pool:
            await self._pool.close()
            self._pool = None
