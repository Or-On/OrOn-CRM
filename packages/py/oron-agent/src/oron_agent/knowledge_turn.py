"""One full knowledge snapshot per inference, with fresh point-of-use authorization."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from copy import deepcopy
from typing import Any

Records = list[dict[str, Any]]


class TurnKnowledgeReader:
    """Owned by one call; no process cache and no reuse after eligibility changes."""

    def __init__(
        self,
        load: Callable[[], Awaitable[Records]],
        revisions: Callable[[], Awaitable[list[str]]] | None = None,
    ):
        self._load = load
        self._revisions = revisions
        self._generation = 0
        self._records: Records | None = None
        self._signature: list[str] | None = None

    async def begin_turn(self) -> Records:
        self._generation += 1
        generation = self._generation
        self._records = None
        self._signature = None
        records = await self._load()
        signature = [
            value
            for record in records
            if isinstance(value := record.get("eligibilityRevision"), str) and value
        ]
        if generation != self._generation:
            return []
        # An older adapter cannot safely authorize a cached snapshot.
        if len(signature) == len(records):
            self._records = deepcopy(records)
            self._signature = signature
        return records

    async def for_speech(self) -> Records:
        generation = self._generation
        if self._revisions is None or self._records is None:
            records = await self._load()
            return records if generation == self._generation else []
        revisions = await self._revisions()
        if generation != self._generation:
            return []
        if revisions != self._signature:
            # Do not resurrect an earlier snapshot if authority is later restored.
            self._records = None
            self._signature = None
            return []
        return deepcopy(self._records)
