"""Deterministic planner for an operator-produced WACRM JSON export."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path
from uuid import UUID, uuid5

from .contracts import WacrmImportPlan, WacrmImportRecord, WacrmSourceSnapshot

FORMAT_VERSION = "wacrm-export-v1"
ENTITY_ORDER = (
    "contacts",
    "channels",
    "conversations",
    "messages",
    "pipelines",
    "pipeline_stages",
    "deals",
)
SINGULAR = {
    "contacts": "contact",
    "channels": "channel",
    "conversations": "conversation",
    "messages": "message",
    "pipelines": "pipeline",
    "pipeline_stages": "pipeline_stage",
    "deals": "deal",
}


class WacrmDataError(ValueError):
    """Safe validation error that never includes exported business content."""


def snapshot_from_path(path: Path) -> WacrmSourceSnapshot:
    raw = path.read_bytes()
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        raise WacrmDataError("WACRM export is not valid JSON") from error
    if not isinstance(document, dict):
        raise WacrmDataError("WACRM export root must be an object")
    version = document.get("formatVersion")
    if version != FORMAT_VERSION:
        raise WacrmDataError(f"WACRM export format must be {FORMAT_VERSION}")
    return WacrmSourceSnapshot(
        dump_path=path,
        sha256=hashlib.sha256(raw).hexdigest(),
        format_version=FORMAT_VERSION,
    )


def _uuid(value: object, label: str) -> UUID:
    try:
        return UUID(str(value))
    except (TypeError, ValueError) as error:
        raise WacrmDataError(f"{label} must be a UUID") from error


def _record_checksum(kind: str, source_id: str, payload: dict[str, object]) -> str:
    serialized = json.dumps(
        {"kind": kind, "source_id": source_id, "payload": payload},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(serialized.encode()).hexdigest()


def build_import_plan(
    snapshot: WacrmSourceSnapshot,
    *,
    account_to_tenant: dict[UUID, UUID],
    source_user_to_canonical_user: dict[UUID, UUID],
) -> WacrmImportPlan:
    if snapshot.format_version != FORMAT_VERSION:
        raise WacrmDataError("unsupported WACRM export format")
    raw = snapshot.dump_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != snapshot.sha256:
        raise WacrmDataError("WACRM export checksum changed after snapshot creation")
    document = json.loads(raw)
    account_ids = {
        _uuid(item.get("id"), "account id")
        for item in document.get("accounts", [])
        if isinstance(item, dict)
    }
    missing_accounts = account_ids.difference(account_to_tenant)
    if missing_accounts:
        raise WacrmDataError("every source account requires an explicit tenant mapping")
    user_ids = {
        _uuid(item.get("id"), "user id")
        for item in document.get("users", [])
        if isinstance(item, dict)
    }
    if user_ids.difference(source_user_to_canonical_user):
        raise WacrmDataError("every source user requires an explicit canonical user mapping")

    target_ids: dict[tuple[str, str], UUID] = {}
    records: list[WacrmImportRecord] = []
    counts: Counter[str] = Counter()
    for plural_kind in ENTITY_ORDER:
        values = document.get(plural_kind, [])
        if not isinstance(values, list):
            raise WacrmDataError(f"{plural_kind} must be an array")
        kind = SINGULAR[plural_kind]
        for value in values:
            if not isinstance(value, dict):
                raise WacrmDataError(f"{kind} entries must be objects")
            source_id = str(_uuid(value.get("id"), f"{kind} id"))
            account_id = _uuid(value.get("accountId"), f"{kind} account id")
            tenant_id = account_to_tenant.get(account_id)
            if tenant_id is None:
                raise WacrmDataError(f"{kind} references an unmapped account")
            target_id = uuid5(tenant_id, f"wacrm:{kind}:{source_id}")
            target_ids[(kind, source_id)] = target_id
            payload: dict[str, object] = {**value, "tenant_id": str(tenant_id)}
            records.append(
                WacrmImportRecord(
                    kind=kind,
                    source_id=source_id,
                    target_id=target_id,
                    tenant_id=tenant_id,
                    payload=payload,
                    checksum=_record_checksum(kind, source_id, payload),
                )
            )
            counts[kind] += 1

    for record in records:
        payload = record.payload
        references = {
            "conversation": (("channel", "channelId"), ("contact", "contactId")),
            "message": (("conversation", "conversationId"),),
            "pipeline_stage": (("pipeline", "pipelineId"),),
            "deal": (
                ("pipeline", "pipelineId"),
                ("pipeline_stage", "stageId"),
                ("contact", "contactId"),
            ),
        }.get(record.kind, ())
        for referenced_kind, field in references:
            raw_reference = payload.get(field)
            if raw_reference is None and record.kind == "deal" and field == "contactId":
                continue
            source_reference = str(_uuid(raw_reference, f"{record.kind} {field}"))
            target_reference = target_ids.get((referenced_kind, source_reference))
            if target_reference is None:
                raise WacrmDataError(f"{record.kind} has an unresolved {field} reference")
            payload[f"target_{field}"] = str(target_reference)

    return WacrmImportPlan(
        source_checksum=snapshot.sha256,
        account_to_tenant=dict(account_to_tenant),
        source_user_to_canonical_user=dict(source_user_to_canonical_user),
        entity_counts=dict(counts),
        records=tuple(records),
    )
