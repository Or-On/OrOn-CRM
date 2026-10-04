from __future__ import annotations

import asyncio

import pytest
from oron_dispatcher.dispatcher import UnroutableInboundCall
from oron_dispatcher.webhook_pump import DurableDelivery, DurableWebhookPump


class Ledger:
    def __init__(self):
        self.pending = [DurableDelivery("fixture", "token", {"id": "fixture"})]
        self.fresh = True
        self.settlements = []
        self.claimed = asyncio.Event()
        self.settled = asyncio.Event()

    async def claim_pending(self, limit):
        rows, self.pending = self.pending[:limit], self.pending[limit:]
        self.claimed.set()
        return rows

    async def renew(self, delivery):
        return self.fresh

    async def settle(self, delivery, outcome, reason):
        if not self.fresh:
            return False
        self.settlements.append((outcome, reason))
        self.settled.set()
        return True


@pytest.mark.asyncio
async def test_shutdown_stops_admission_and_awaits_handler_child_cleanup():
    ledger = Ledger()
    started, cleaned = asyncio.Event(), asyncio.Event()

    async def handle(delivery):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0.01)
            cleaned.set()

    pump = DurableWebhookPump(ledger, handle, poll_seconds=0.001)
    pump.start()
    await started.wait()
    await pump.close()
    assert cleaned.is_set() and not pump.admitting and not pump._tasks
    assert ledger.settlements == []


@pytest.mark.asyncio
async def test_lost_heartbeat_cancels_handler_without_old_settlement():
    ledger = Ledger()
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def handle(delivery):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    pump = DurableWebhookPump(ledger, handle, poll_seconds=0.001, heartbeat_seconds=0.005)
    pump.start()
    await started.wait()
    ledger.fresh = False
    await asyncio.wait_for(cancelled.wait(), 1)
    await pump.close()
    assert ledger.settlements == []


@pytest.mark.asyncio
async def test_expired_claim_never_starts_handler():
    ledger = Ledger()
    ledger.fresh = False
    calls = []

    async def handle(delivery):
        calls.append(delivery)

    pump = DurableWebhookPump(ledger, handle, poll_seconds=0.001)
    pump.start()
    await asyncio.wait_for(ledger.claimed.wait(), 1)
    await pump.close()
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error,outcome,reason",
    [
        (None, "processed", None),
        (RuntimeError("private error"), "failed", "dispatcher_handler_failed"),
        (
            UnroutableInboundCall("voice_agent_unavailable"),
            "quarantined",
            "voice_agent_unavailable",
        ),
    ],
)
async def test_terminal_result_is_durable_and_errors_are_safe(error, outcome, reason):
    ledger = Ledger()

    async def handle(delivery):
        if error is not None:
            raise error

    pump = DurableWebhookPump(ledger, handle, poll_seconds=0.001)
    pump.start()
    await asyncio.wait_for(ledger.settled.wait(), 1)
    await pump.close()
    assert ledger.settlements == [(outcome, reason)]
