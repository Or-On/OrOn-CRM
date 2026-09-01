"""PII-safe dry-run CLI for the isolated OpenLive legacy importer."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from uuid import UUID

from .models import ImportResult, PlannerConfig, execute_import
from .planner import build_import_plan
from .postgres_writer import PostgresCanonicalWriter


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", required=True, type=UUID)
    parser.add_argument("--user-id", required=True, type=UUID)
    parser.add_argument("--sqlite", type=Path)
    parser.add_argument("--conversations", type=Path)
    parser.add_argument("--providers", type=Path)
    parser.add_argument("--settings", type=Path)
    parser.add_argument("--voice-profiles", type=Path)
    parser.add_argument("--voices-directory", type=Path)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="reserved for the Phase 2B canonical PostgreSQL writer",
    )
    return parser


def main() -> None:
    arguments = _parser().parse_args()
    plan = build_import_plan(
        PlannerConfig(
            tenant_id=arguments.tenant_id,
            user_id=arguments.user_id,
            sqlite_path=arguments.sqlite,
            conversations_path=arguments.conversations,
            providers_path=arguments.providers,
            settings_path=arguments.settings,
            voice_profiles_path=arguments.voice_profiles,
            voices_directory=arguments.voices_directory,
        )
    )
    writer = None
    if arguments.apply:
        database_url = os.environ.get("MIGRATION_DATABASE_URL")
        if not database_url:
            raise RuntimeError("--apply requires MIGRATION_DATABASE_URL for canonical PostgreSQL")
        writer = PostgresCanonicalWriter(database_url)
    result = execute_import(plan, dry_run=not arguments.apply, writer=writer)
    output = (
        {
            "import_run_id": str(result.import_run_id),
            "imported_count": result.imported_count,
            "skipped_count": result.skipped_count,
        }
        if isinstance(result, ImportResult)
        else result
    )
    print(json.dumps(output, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
