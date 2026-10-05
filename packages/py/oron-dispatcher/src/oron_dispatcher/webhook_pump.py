"""Bounded durable LiveKit replay pump; no HTTP request owns handler lifetime."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

from oron_dispatcher.dispatcher import AdmissionUnavailable, UnroutableInboundCall

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class DurableDelivery:
    event_id: str
    token: str
    payload: dict[str, object]


class DurableLedger(Protocol):
    async def claim_pending(self, limit: int) -> list[DurableDelivery]: ...
    async def renew(self, delivery: DurableDelivery) -> bool: ...
    async def settle(self, delivery: DurableDelivery, outcome: str, reason: str | None) -> bool: ...


class DurableWebhookPump:
    """Keep strong task ownership and fence execution with renewable DB leases."""

    def __init__(
        self,
        ledger: DurableLedger,
        handle: Callable[[DurableDelivery], Awaitable[None]],
        *,
        concurrency: int = 8,
        poll_seconds: float = 0.2,
        heartbeat_seconds: float = 10,
    ) -> None:
        if not 1 <= concurrency <= 16 or poll_seconds <= 0 or heartbeat_seconds <= 0:
            raise ValueError("invalid durable pump limits")
        self._ledger = ledger
        self._handle = handle
        self._concurrency = concurrency
        self._poll_seconds = poll_seconds
        self._heartbeat_seconds = heartbeat_seconds
        self._admitting = False
        self._loop: asyncio.Task[None] | None = None
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def admitting(self) -> bool:
        return self._admitting

    def start(self) -> None:
        if self._loop is not None:
            raise RuntimeError("durable pump already started")
        self._admitting = True
        self._loop = asyncio.create_task(self._run(), name="livekit-durable-pump")

    async def _run(self) -> None:
        while self._admitting:
            try:
                remaining = self._concurrency - len(self._tasks)
                if remaining:
                    deliveries = await self._ledger.claim_pending(remaining)
                    for delivery in deliveries:
                        # Shutdown can begin while the claim query is in flight. Leave
                        # those claims for lease expiry rather than launching new calls.
                        if not self._admitting:
                            break
                        task = asyncio.create_task(self._process(delivery))
                        self._tasks.add(task)
                        task.add_done_callback(self._finished)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "LiveKit durable poll failed", extra={"error_type": type(exc).__name__}
                )
            await asyncio.sleep(self._poll_seconds)

    def _finished(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if not task.cancelled():
            error = task.exception()
            if error is not None:
                logger.warning(
                    "LiveKit durable handler failed", extra={"error_type": type(error).__name__}
                )

    async def _process(self, delivery: DurableDelivery) -> None:
        # Refuse expired/replaced claims before any admission or provider side effect.
        if not await self._renew(delivery):
            return

        async def run_handler() -> None:
            await self._handle(delivery)

        handler = asyncio.create_task(run_handler())
        lease = asyncio.create_task(self._heartbeat(delivery))
        try:
            completed, _ = await asyncio.wait((handler, lease), return_when=asyncio.FIRST_COMPLETED)
            if lease in completed:
                # Lease loss or an unknown DB outcome always stops handler I/O.
                handler.cancel()
                await asyncio.gather(handler, return_exceptions=True)
                return
            try:
                await handler
            except asyncio.CancelledError:
                raise
            except AdmissionUnavailable:
                await self._ledger.settle(delivery, "quarantined", "voice_admission_unavailable")
            except UnroutableInboundCall as exc:
                await self._ledger.settle(delivery, "quarantined", exc.reason)
            except Exception as exc:
                # Parse/provider exceptions may embed private payload values.
                # The class remains useful even with the plain text formatter.
                logger.warning(
                    "LiveKit durable event handler failed (error_type=%s)", type(exc).__name__
                )
                await self._ledger.settle(delivery, "failed", "dispatcher_handler_failed")
            else:
                await self._ledger.settle(delivery, "processed", None)
        finally:
            handler.cancel()
            lease.cancel()
            # Await cancellation cleanup, including a dispatcher's shielded startup.
            await asyncio.gather(handler, lease, return_exceptions=True)

    async def _renew(self, delivery: DurableDelivery) -> bool:
        # An unknown/hung DB outcome cannot allow provider work beyond its lease.
        async with asyncio.timeout(5):
            return await self._ledger.renew(delivery)

    async def _heartbeat(self, delivery: DurableDelivery) -> None:
        while True:
            await asyncio.sleep(self._heartbeat_seconds)
            try:
                if not await self._renew(delivery):
                    return
            except Exception:
                return

    async def close(self) -> None:
        # Call before dispatcher drain and ledger close. No new claimed work starts.
        self._admitting = False
        if self._loop is not None:
            self._loop.cancel()
            await asyncio.gather(self._loop, return_exceptions=True)
            self._loop = None
        tasks = tuple(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
