"""Provider-neutral WACRM dump/import boundaries; implementation is deferred."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import UUID


@dataclass(frozen=True, slots=True)
class WacrmSourceSnapshot:
    dump_path: Path
    sha256: str
    format_version: str


@dataclass(frozen=True, slots=True)
class WacrmImportPlan:
    source_checksum: str
    account_to_tenant: dict[UUID, UUID]
    source_user_to_canonical_user: dict[UUID, UUID]
    entity_counts: dict[str, int]


class WacrmImportPlanner(Protocol):
    def plan(
        self,
        snapshot: WacrmSourceSnapshot,
        *,
        account_to_tenant: dict[UUID, UUID],
        source_user_to_canonical_user: dict[UUID, UUID],
    ) -> WacrmImportPlan: ...
