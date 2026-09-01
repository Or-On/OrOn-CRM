from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from uuid import UUID

import pytest

from db.importers.openlive_legacy.models import PlannerConfig, execute_import
from db.importers.openlive_legacy.planner import LegacyDataError, build_import_plan

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
USER_ID = UUID("20000000-0000-0000-0000-000000000002")
FIXTURES = Path(__file__).parent / "fixtures"


def _sqlite_fixture(path: Path) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.executescript(
            """
            CREATE TABLE chats (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT,
              agent_id TEXT,
              cwd TEXT,
              agent_session_id TEXT
            );
            CREATE TABLE messages (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              id TEXT NOT NULL UNIQUE,
              chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              live INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL
            );
            """
        )
        connection.execute(
            "INSERT INTO chats VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                "sqlite-chat-1",
                "Fictional SQLite chat",
                "2026-02-01T01:02:03Z",
                None,
                "fixture-agent",
                "C:/fictional/sqlite",
                "fixture-acp-session",
            ),
        )
        connection.execute(
            "INSERT INTO messages (id, chat_id, role, content, live, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                "sqlite-message-1",
                "sqlite-chat-1",
                "assistant",
                json.dumps([{"type": "text", "text": "Fictional reply"}]),
                1,
                "2026-02-01T01:02:04Z",
            ),
        )
        connection.commit()
    finally:
        connection.close()


def _config(**overrides: object) -> PlannerConfig:
    values: dict[str, object] = {
        "tenant_id": TENANT_ID,
        "user_id": USER_ID,
        "conversations_path": FIXTURES / "conversations.json",
        "providers_path": FIXTURES / "providers.json",
        "settings_path": FIXTURES / "settings.json",
        "voice_profiles_path": FIXTURES / "voice-profiles.json",
    }
    values.update(overrides)
    return PlannerConfig(**values)  # type: ignore[arg-type]


def test_fixture_plan_is_deterministic_and_redacts_secrets() -> None:
    first = build_import_plan(_config())
    second = build_import_plan(_config())

    assert first == second
    assert first.source_checksum == second.source_checksum
    assert [record.target_id for record in first.records] == [
        record.target_id for record in second.records
    ]
    safe_output = json.dumps(execute_import(first, dry_run=True), sort_keys=True)
    assert "fixture-secret-never-imported" not in safe_output
    assert "Fictional fixture content" not in safe_output
    assert "legacy plaintext secret settings were not imported" in safe_output
    assert "legacy executable command settings require manual review" in safe_output


def test_sqlite_parser_preserves_append_sequence(tmp_path: Path) -> None:
    sqlite_path = tmp_path / "openlive.db"
    _sqlite_fixture(sqlite_path)

    plan = build_import_plan(
        PlannerConfig(tenant_id=TENANT_ID, user_id=USER_ID, sqlite_path=sqlite_path)
    )
    message = next(record for record in plan.records if record.kind == "message")

    assert message.payload["sequence"] == 1
    assert message.payload["is_live"] is True
    assert plan.safe_summary()["record_counts"] == {"chat": 1, "message": 1}


def test_identical_cross_store_records_are_deduplicated(tmp_path: Path) -> None:
    sqlite_path = tmp_path / "openlive.db"
    connection = sqlite3.connect(sqlite_path)
    document = json.loads((FIXTURES / "conversations.json").read_text(encoding="utf-8"))
    chat = document["chats"][0]
    message = document["messages"][0]
    try:
        connection.executescript(
            """
            CREATE TABLE chats (
              id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
              updated_at TEXT, agent_id TEXT, cwd TEXT, agent_session_id TEXT
            );
            CREATE TABLE messages (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
              live INTEGER NOT NULL, created_at TEXT NOT NULL
            );
            """
        )
        connection.execute(
            "INSERT INTO chats VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                chat["id"],
                chat["title"],
                chat["createdAt"],
                chat["updatedAt"],
                chat["agentId"],
                chat["cwd"],
                chat["agentSessionId"],
            ),
        )
        connection.execute(
            "INSERT INTO messages (id, chat_id, role, content, live, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                message["id"],
                message["chatId"],
                message["role"],
                json.dumps(message["content"]),
                0,
                message["createdAt"],
            ),
        )
        connection.commit()
    finally:
        connection.close()

    plan = build_import_plan(_config(sqlite_path=sqlite_path))

    assert plan.duplicate_count == 2
    assert len([record for record in plan.records if record.kind in {"chat", "message"}]) == 2


def test_conflicting_duplicate_is_rejected_without_exposing_content(tmp_path: Path) -> None:
    conflicting = json.loads((FIXTURES / "conversations.json").read_text(encoding="utf-8"))
    conflicting["chats"].append({**conflicting["chats"][0], "title": "private conflict"})
    path = tmp_path / "conversations.json"
    path.write_text(json.dumps(conflicting), encoding="utf-8")

    with pytest.raises(LegacyDataError, match="conflicting duplicate chat record") as captured:
        build_import_plan(
            PlannerConfig(tenant_id=TENANT_ID, user_id=USER_ID, conversations_path=path)
        )

    assert "private conflict" not in str(captured.value)


def test_live_apply_requires_canonical_postgres_writer() -> None:
    plan = build_import_plan(_config())

    with pytest.raises(RuntimeError, match="pending Phase 2B"):
        execute_import(plan, dry_run=False)
