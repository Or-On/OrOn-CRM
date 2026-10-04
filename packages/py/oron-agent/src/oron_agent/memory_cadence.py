"""Canonical final-turn capture port; server owns cadence and memory authority."""

import asyncio
from collections.abc import Awaitable, Callable


class VoiceMemoryCapture:
    """One call's sequential port, with no inference or identity assertions.

    The persistence implementation must derive session/tenant/Agent and authorize
    every write. Neither this counter nor the caller's text confers verification.
    An ambiguous failed write is retried with the same ordinal, never a new ID.
    """

    def __init__(
        self,
        append: Callable[[int, str], Awaitable[None]],
        finish: Callable[[], Awaitable[None]],
    ) -> None:
        self._append = append
        self._finish = finish
        self._ordinal = 0
        self._pending: tuple[int, str] | None = None
        self._finished = False
        self._lock = asyncio.Lock()

    async def final_turn(self, text: str) -> None:
        async with self._lock:
            await self._final_turn(text)

    async def _final_turn(self, text: str) -> None:
        if self._finished:
            raise RuntimeError("voice memory capture is finalized")
        if not text.strip():
            return
        if len(text) > 4000:
            raise ValueError("voice memory turn exceeds bounded source length")
        if self._pending is not None:
            await self._flush()
        self._pending = (self._ordinal + 1, text)
        await self._flush()

    async def _flush(self) -> None:
        if self._pending is None:
            return
        ordinal, text = self._pending
        await self._append(ordinal, text)
        self._ordinal = ordinal
        self._pending = None

    async def finish(self) -> None:
        async with self._lock:
            await self._finish_once()

    async def _finish_once(self) -> None:
        if self._finished:
            return
        await self._flush()
        await self._finish()
        self._finished = True
