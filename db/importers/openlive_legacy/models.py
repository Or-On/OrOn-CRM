"""Typed, deterministic import-plan models with safe diagnostics."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import UUID


@dataclass(frozen=True, slots=True)
class PlannerConfig:
    """Explicit source and destination scope for an OpenLive legacy import."""

    tenant_id: UUID
    user_id: UUID
    sqlite_path: Path | None = None
    conversations_path: Path | None = None
    providers_path: Path | None = None
    settings_path: Path | None = None
    voice_profiles_path: Path | None = None
    voices_directory: Path | None = None


@dataclass(frozen=True, slots=True)
class SourceDigest:
    label: str
    sha256: str
    byte_size: int


@dataclass(frozen=True, slots=True)
class ImportRecord:
    kind: str
    source_id: str
    target_id: UUID
    payload: dict[str, object]
    checksum: str


@dataclass(frozen=True, slots=True)
class ImportPlan:
    tenant_id: UUID
    user_id: UUID
    source_checksum: str
    sources: tuple[SourceDigest, ...]
    records: tuple[ImportRecord, ...]
    duplicate_count: int
    warnings: tuple[str, ...]

    def safe_summary(self) -> dict[str, object]:
        """Return counts and digests only—never legacy content, secrets, or paths."""

        counts = Counter(record.kind for record in self.records)
        return {
            "mode": "dry-run",
            "tenant_id": str(self.tenant_id),
            "user_id": str(self.user_id),
            "source_checksum": self.source_checksum,
            "source_count": len(self.sources),
            "record_counts": dict(sorted(counts.items())),
            "duplicate_count": self.duplicate_count,
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True, slots=True)
class ImportResult:
    import_run_id: UUID
    imported_count: int
    skipped_count: int


class CanonicalPostgresWriter(Protocol):
    """Phase 2B port: writes a plan through canonical PostgreSQL transactions."""

    def write(self, plan: ImportPlan) -> ImportResult: ...


def execute_import(
    plan: ImportPlan,
    *,
    dry_run: bool,
    writer: CanonicalPostgresWriter | None = None,
) -> dict[str, object] | ImportResult:
    if dry_run:
        return plan.safe_summary()
    if writer is None:
        raise RuntimeError(
            "PostgreSQL writer is required; live writes are pending Phase 2B validation"
        )
    return writer.write(plan)
