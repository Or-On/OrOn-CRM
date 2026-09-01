"""Read legacy OpenLive stores and produce an idempotent canonical import plan."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid5

from .models import ImportPlan, ImportRecord, PlannerConfig, SourceDigest

IMPORT_NAMESPACE = UUID("9041629d-caf5-4fae-9698-1158047ca03c")
SAFE_SETTING_KEYS = {
    "agentCwd",
    "agent_notes",
    "customInstructions",
    "liveEffort",
    "liveModel",
    "liveProviderId",
    "narrateProgress",
    "visionModel",
    "visionProviderId",
}
SAFE_SETTING_PREFIXES = ("acpSession:", "agentCwd:", "agentHidden:", "bind:")
REVIEW_SETTING_PREFIXES = ("acpCommand:",)
SECRET_SETTING_KEYS = {"exa_api_key"}


class LegacyDataError(ValueError):
    """A legacy record is malformed or collides with different content."""


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _checksum_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _file_digest(path: Path, label: str) -> SourceDigest:
    digest = hashlib.sha256()
    byte_size = 0
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
            byte_size += len(block)
    return SourceDigest(label=label, sha256=digest.hexdigest(), byte_size=byte_size)


def _normalized_instant(value: object, *, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LegacyDataError(f"{field} must be a non-empty timestamp")
    try:
        instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise LegacyDataError(f"{field} is not an ISO-8601 timestamp") from error
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=UTC)
    return instant.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _required_text(value: object, *, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LegacyDataError(f"{field} must be a non-empty string")
    return value


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _target_id(tenant_id: UUID, kind: str, source_id: str) -> UUID:
    return uuid5(IMPORT_NAMESPACE, f"{tenant_id}:{kind}:{source_id}")


class _PlanBuilder:
    def __init__(self, config: PlannerConfig) -> None:
        self.config = config
        self.sources: list[SourceDigest] = []
        self.records: dict[tuple[str, str], ImportRecord] = {}
        self.duplicate_count = 0
        self.warnings: set[str] = set()

    def add_source(self, path: Path, label: str) -> None:
        self.sources.append(_file_digest(path, label))

    def add_record(self, kind: str, source_id: str, payload: dict[str, object]) -> None:
        key = (kind, source_id)
        checksum = _checksum_bytes(_canonical_json(payload))
        record = ImportRecord(
            kind=kind,
            source_id=source_id,
            target_id=_target_id(self.config.tenant_id, kind, source_id),
            payload=payload,
            checksum=checksum,
        )
        existing = self.records.get(key)
        if existing is None:
            self.records[key] = record
            return
        if existing.checksum != record.checksum:
            raise LegacyDataError(f"conflicting duplicate {kind} record")
        self.duplicate_count += 1

    def finish(self) -> ImportPlan:
        if not self.sources:
            raise LegacyDataError("at least one explicit legacy source file is required")
        sources = tuple(sorted(self.sources, key=lambda item: item.label))
        source_checksum = _checksum_bytes(
            _canonical_json([(source.label, source.sha256, source.byte_size) for source in sources])
        )
        records = tuple(
            self.records[key] for key in sorted(self.records, key=lambda item: (item[0], item[1]))
        )
        return ImportPlan(
            tenant_id=self.config.tenant_id,
            user_id=self.config.user_id,
            source_checksum=source_checksum,
            sources=sources,
            records=records,
            duplicate_count=self.duplicate_count,
            warnings=tuple(sorted(self.warnings)),
        )


def _chat_payload(config: PlannerConfig, row: Mapping[str, object]) -> dict[str, object]:
    created_at = _normalized_instant(
        row.get("created_at", row.get("createdAt")), field="chat.created_at"
    )
    return {
        "tenant_id": str(config.tenant_id),
        "owner_user_id": str(config.user_id),
        "title": _required_text(row.get("title"), field="chat.title"),
        "agent_id": _optional_text(row.get("agent_id", row.get("agentId"))),
        "workspace_path": _optional_text(row.get("cwd")),
        "external_session_id": _optional_text(
            row.get("agent_session_id", row.get("agentSessionId"))
        ),
        "created_at": created_at,
        "updated_at": _normalized_instant(
            row.get("updated_at", row.get("updatedAt")) or created_at,
            field="chat.updated_at",
        ),
    }


def _message_payload(
    config: PlannerConfig,
    row: Mapping[str, object],
    *,
    sequence: int,
) -> dict[str, object]:
    content = row.get("content", [])
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except json.JSONDecodeError as error:
            raise LegacyDataError("message content is not valid JSON") from error
    if not isinstance(content, list | dict):
        raise LegacyDataError("message content must be a JSON array or object")
    chat_source_id = _required_text(row.get("chat_id", row.get("chatId")), field="message.chat_id")
    role = _required_text(row.get("role"), field="message.role")
    if role not in {"user", "assistant", "system", "tool", "event"}:
        raise LegacyDataError("message role is unsupported")
    return {
        "tenant_id": str(config.tenant_id),
        "chat_target_id": str(_target_id(config.tenant_id, "chat", chat_source_id)),
        "sequence": sequence,
        "role": role,
        "content": content,
        "is_live": bool(row.get("live", False)),
        "created_at": _normalized_instant(
            row.get("created_at", row.get("createdAt")), field="message.created_at"
        ),
    }


def _sqlite_rows(connection: sqlite3.Connection, table: str) -> Iterable[sqlite3.Row]:
    exists = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    if exists is None:
        return ()
    order = "id" if table == "chats" else "seq"
    return connection.execute(f'SELECT * FROM "{table}" ORDER BY "{order}"').fetchall()  # noqa: S608


def _load_sqlite(builder: _PlanBuilder, path: Path) -> None:
    builder.add_source(path, "openlive.db")
    wal_path = path.with_name(f"{path.name}-wal")
    if wal_path.exists():
        builder.add_source(wal_path, "openlive.db-wal")
    connection = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        chat_ids: set[str] = set()
        for row in _sqlite_rows(connection, "chats"):
            source_id = _required_text(row["id"], field="chat.id")
            chat_ids.add(source_id)
            builder.add_record("chat", source_id, _chat_payload(builder.config, dict(row)))
        for row in _sqlite_rows(connection, "messages"):
            source_id = _required_text(row["id"], field="message.id")
            chat_id = _required_text(row["chat_id"], field="message.chat_id")
            if chat_id not in chat_ids:
                builder.warnings.add("orphan SQLite messages were skipped")
                continue
            builder.add_record(
                "message",
                source_id,
                _message_payload(builder.config, dict(row), sequence=int(row["seq"])),
            )
    finally:
        connection.close()


def _load_json(path: Path, *, expected: type[dict[object, object]] | type[list[object]]) -> object:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise LegacyDataError(f"{path.name} is not readable canonical JSON") from error
    if not isinstance(value, expected):
        raise LegacyDataError(f"{path.name} has an unexpected JSON shape")
    return value


def _load_conversations(builder: _PlanBuilder, path: Path) -> None:
    builder.add_source(path, "conversations.json")
    document = _load_json(path, expected=dict)
    assert isinstance(document, dict)
    chats = document.get("chats", [])
    messages = document.get("messages", [])
    if not isinstance(chats, list) or not isinstance(messages, list):
        raise LegacyDataError("conversations.json requires chats and messages arrays")
    chat_ids: set[str] = set()
    for item in chats:
        if not isinstance(item, dict):
            raise LegacyDataError("conversation chat entry must be an object")
        source_id = _required_text(item.get("id"), field="chat.id")
        chat_ids.add(source_id)
        builder.add_record("chat", source_id, _chat_payload(builder.config, item))
    for sequence, item in enumerate(messages, start=1):
        if not isinstance(item, dict):
            raise LegacyDataError("conversation message entry must be an object")
        chat_id = _required_text(item.get("chatId"), field="message.chat_id")
        if chat_id not in chat_ids:
            builder.warnings.add("orphan JSON messages were skipped")
            continue
        source_id = _required_text(item.get("id"), field="message.id")
        builder.add_record(
            "message",
            source_id,
            _message_payload(builder.config, item, sequence=sequence),
        )


def _load_providers(builder: _PlanBuilder, path: Path) -> None:
    builder.add_source(path, "providers.json")
    document = _load_json(path, expected=list)
    assert isinstance(document, list)
    for item in document:
        if not isinstance(item, dict):
            raise LegacyDataError("provider entry must be an object")
        source_id = _required_text(item.get("id"), field="provider.id")
        ciphertext = item.get("apiKeyCiphertext")
        if ciphertext:
            builder.warnings.add("legacy provider ciphertext requires approved credential rewrap")
        builder.add_record(
            "provider_configuration",
            source_id,
            {
                "tenant_id": str(builder.config.tenant_id),
                "owner_user_id": str(builder.config.user_id),
                "provider_kind": _required_text(item.get("kind"), field="provider.kind"),
                "name": _required_text(item.get("name"), field="provider.name"),
                "display_hint": _optional_text(item.get("keyLast4")),
                "has_legacy_ciphertext": bool(ciphertext),
                "is_default": bool(item.get("isDefault", False)),
                "is_enabled": False,
            },
        )


def _load_settings(builder: _PlanBuilder, path: Path) -> None:
    builder.add_source(path, "settings.json")
    document = _load_json(path, expected=dict)
    assert isinstance(document, dict)
    for key in sorted(document):
        value = document[key]
        if not isinstance(key, str) or not isinstance(value, str):
            raise LegacyDataError("settings entries must be string key/value pairs")
        if key in SECRET_SETTING_KEYS:
            builder.warnings.add("legacy plaintext secret settings were not imported")
            continue
        if key.startswith(REVIEW_SETTING_PREFIXES):
            builder.warnings.add("legacy executable command settings require manual review")
            continue
        if key not in SAFE_SETTING_KEYS and not key.startswith(SAFE_SETTING_PREFIXES):
            builder.warnings.add("unknown legacy settings were not imported")
            continue
        builder.add_record(
            "user_preference",
            key,
            {
                "tenant_id": str(builder.config.tenant_id),
                "user_id": str(builder.config.user_id),
                "key": key,
                "value": value,
                "source": "legacy_import",
            },
        )


def _load_voice_profiles(builder: _PlanBuilder, path: Path, voices_directory: Path | None) -> None:
    builder.add_source(path, "voice-profiles.json")
    document = _load_json(path, expected=list)
    assert isinstance(document, list)
    for item in document:
        if not isinstance(item, dict):
            raise LegacyDataError("voice profile entry must be an object")
        source_id = _required_text(item.get("id"), field="voice_profile.id")
        wav_name = _required_text(item.get("wavFile"), field="voice_profile.wav_file")
        audio_metadata: dict[str, object] = {"legacy_file_name": Path(wav_name).name}
        if voices_directory is not None:
            root = voices_directory.resolve()
            audio_path = (root / wav_name).resolve()
            if not audio_path.is_relative_to(root):
                raise LegacyDataError("voice profile path escapes the explicit voices directory")
            if audio_path.is_file():
                digest = _file_digest(audio_path, f"voice-audio:{source_id}")
                builder.sources.append(digest)
                audio_metadata.update(
                    {"audio_sha256": digest.sha256, "audio_byte_size": digest.byte_size}
                )
            else:
                builder.warnings.add("referenced voice audio was not found")
        builder.add_record(
            "voice_profile",
            source_id,
            {
                "tenant_id": str(builder.config.tenant_id),
                "owner_user_id": str(builder.config.user_id),
                "name": _required_text(item.get("name"), field="voice_profile.name"),
                "transcript": _optional_text(item.get("transcript")),
                "duration_seconds": item.get("seconds"),
                "source_kind": "legacy_import",
                "created_at": _normalized_instant(
                    item.get("createdAt"), field="voice_profile.created_at"
                ),
                "metadata": audio_metadata,
            },
        )


def build_import_plan(config: PlannerConfig) -> ImportPlan:
    """Parse every explicitly supplied source and return a deterministic dry-run plan."""

    builder = _PlanBuilder(config)
    sources: tuple[tuple[Path | None, str], ...] = (
        (config.sqlite_path, "sqlite"),
        (config.conversations_path, "conversations"),
        (config.providers_path, "providers"),
        (config.settings_path, "settings"),
        (config.voice_profiles_path, "voice_profiles"),
    )
    for path, label in sources:
        if path is not None and not path.is_file():
            raise LegacyDataError(f"explicit {label} source does not exist")
    if config.sqlite_path is not None:
        _load_sqlite(builder, config.sqlite_path)
    if config.conversations_path is not None:
        _load_conversations(builder, config.conversations_path)
    if config.providers_path is not None:
        _load_providers(builder, config.providers_path)
    if config.settings_path is not None:
        _load_settings(builder, config.settings_path)
    if config.voice_profiles_path is not None:
        _load_voice_profiles(builder, config.voice_profiles_path, config.voices_directory)
    return builder.finish()
