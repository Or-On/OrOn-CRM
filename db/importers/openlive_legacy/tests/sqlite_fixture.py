"""SQLite source fixture builder isolated inside one-time importer tests."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path


def create_sqlite_fixture(path: Path) -> None:
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
