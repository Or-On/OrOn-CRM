"""Provider-neutral WACRM export/import boundaries."""

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
class WacrmImportRecord:
    kind: str
    source_id: str
    target_id: UUID
    tenant_id: UUID
    payload: dict[str, object]
    checksum: str


@dataclass(frozen=True, slots=True)
class WacrmImportPlan:
    source_checksum: str
    account_to_tenant: dict[UUID, UUID]
    source_user_to_canonical_user: dict[UUID, UUID]
    entity_counts: dict[str, int]
    records: tuple[WacrmImportRecord, ...]

    def safe_summary(self) -> dict[str, object]:
        return {
            "source_checksum": self.source_checksum,
            "tenant_count": len(set(self.account_to_tenant.values())),
            "user_mapping_count": len(self.source_user_to_canonical_user),
            "entity_counts": dict(sorted(self.entity_counts.items())),
        }


@dataclass(frozen=True, slots=True)
class WacrmImportResult:
    import_run_ids: tuple[UUID, ...]
    imported_count: int
    skipped_count: int


class WacrmImportPlanner(Protocol):
    def plan(
        self,
        snapshot: WacrmSourceSnapshot,
        *,
        account_to_tenant: dict[UUID, UUID],
        source_user_to_canonical_user: dict[UUID, UUID],
    ) -> WacrmImportPlan: ...
