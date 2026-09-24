"""Reconcile inbound calls against durable intake records (read-only).

Every inbound SIP participant that reached the dispatcher's signed-webhook
ledger is traced to a disposition:

    provider webhook -> admission (session) -> intake draft -> inquiry (ticket)
    -> WhatsApp follow-up -> customer reply -> case

and summarized with sanitized identifiers only (a keyed hash of the caller
number plus its last two digits, never the number). A deduplicated dry-run
recovery list is produced for calls that reached the platform but left no
inquiry. Nothing is written, nobody is contacted, and no record is created.

Coverage limits are reported rather than hidden: the ledger only contains
events LiveKit delivered to this dispatcher, so calls the SIP provider
received but never forwarded are only visible with the provider's own call
records (``--provider-cdr``).

Usage (read-only role recommended; RLS-bypassing role needed to see all
tenants):

    python scripts/audit_voice_intake.py --database-url "$AUDIT_DATABASE_URL" \\
        --since 2026-08-25 --until 2026-09-24 --timezone Asia/Jerusalem \\
        --output audit.json [--provider-cdr provider_calls.csv]
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import hmac
import json
import os
import sys
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5
from zoneinfo import ZoneInfo

import asyncpg

# Dispositions, in lifecycle order.
UNROUTABLE = "unroutable_did_quarantined"
NOT_ADMITTED = "reached_dispatcher_not_admitted"
NO_SESSION = "webhook_processed_but_no_session"
NO_CONTACT = "admitted_unidentified_caller"
NO_INTAKE = "admitted_no_service_details_saved"
INTAKE_ONLY = "details_saved_no_inquiry"
INQUIRY_OPEN = "inquiry_visible_incomplete"
CASE_OPENED = "inquiry_with_service_case"
ACTIVE = "call_in_progress_or_unfinalized"
OUTBOUND_SKIPPED = "not_an_inbound_call"

RECOVERY_DISPOSITIONS = {NOT_ADMITTED, NO_SESSION, NO_INTAKE, INTAKE_ONLY}


@dataclass
class CallTrace:
    event_id: str
    provider_event_id: str
    received_at: str
    room: str | None
    session_id: str | None
    caller: str
    dialed_tenant_id: str | None
    webhook_status: str
    webhook_error: str | None
    attempts: int
    disposition: str
    session_status: str | None = None
    session_outcome: str | None = None
    intake_status: str | None = None
    ticket_reference: str | None = None
    ticket_stage: str | None = None
    case_reference: str | None = None
    followup_status: str | None = None
    customer_replied: bool = False


@dataclass
class AuditReport:
    window: dict[str, str]
    data_sources: list[str]
    coverage_gaps: list[str] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    webhook_statuses: dict[str, int] = field(default_factory=dict)
    followups: dict[str, int] = field(default_factory=dict)
    unresolved_reply_links: int = 0
    provider_reconciliation: dict[str, Any] | None = None
    recovery_dry_run: list[dict[str, Any]] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)


def sanitize_caller(number: str | None, key: bytes) -> str:
    """A stable, keyed, non-reversible caller reference for reconciliation."""

    if not number:
        return "withheld"
    digest = hmac.new(key, number.encode(), hashlib.sha256).hexdigest()[:10]
    return f"c_{digest}…{number[-2:]}"


def room_session_id(room: str) -> UUID:
    """The dispatcher derives an inbound session id from the LiveKit room."""

    return uuid5(NAMESPACE_URL, f"or-on-platform:livekit-room:{room}")


def _window(since: date, until: date, zone: ZoneInfo) -> tuple[datetime, datetime]:
    start = datetime.combine(since, time.min, zone)
    end = datetime.combine(until + timedelta(days=1), time.min, zone)
    return start.astimezone(UTC), end.astimezone(UTC)


def _participant(payload: dict[str, Any]) -> dict[str, Any]:
    participant = payload.get("participant")
    return participant if isinstance(participant, dict) else {}


def _attributes(payload: dict[str, Any]) -> dict[str, Any]:
    attributes = _participant(payload).get("attributes")
    return attributes if isinstance(attributes, dict) else {}


def _is_sip(payload: dict[str, Any]) -> bool:
    kind = _participant(payload).get("kind")
    return kind in {"SIP", 3, "3"} or "sip.trunkPhoneNumber" in _attributes(payload)


async def collect(
    connection: asyncpg.Connection,
    start: datetime,
    end: datetime,
    *,
    tenant_id: UUID | None,
    hash_key: bytes,
) -> tuple[list[CallTrace], AuditReport]:
    report = AuditReport(
        window={"start_utc": start.isoformat(), "end_utc": end.isoformat()},
        data_sources=[
            "ops.inbound_events (signed LiveKit webhook ledger)",
            "public.phone_numbers (DID -> tenant)",
            "public.sessions and public.session_events",
            "service.intake_drafts, service.cases",
            "support.tickets",
            "ops.jobs and messaging.messages (WhatsApp follow-up)",
            "service.followup_triage",
        ],
    )
    numbers = {
        row["e164"]: str(row["tenant_id"])
        for row in await connection.fetch("SELECT e164, tenant_id FROM public.phone_numbers")
    }
    events = await connection.fetch(
        """
        SELECT id, provider_event_id, event_type, payload, status, last_error_safe,
               attempts, received_at
        FROM ops.inbound_events
        WHERE provider = 'livekit' AND received_at >= $1 AND received_at < $2
        ORDER BY received_at, id
        """,
        start,
        end,
    )
    report.webhook_statuses = dict(
        Counter(f"{row['event_type']}:{row['status']}" for row in events)
    )
    traces: list[CallTrace] = []
    for row in events:
        if row["event_type"] != "participant_joined":
            continue
        payload = row["payload"] if isinstance(row["payload"], dict) else json.loads(row["payload"])
        if not _is_sip(payload):
            continue
        attributes = _attributes(payload)
        dialed = attributes.get("sip.trunkPhoneNumber")
        dialed_tenant = numbers.get(dialed) if isinstance(dialed, str) else None
        if tenant_id is not None and dialed_tenant != str(tenant_id):
            continue
        room_value = (
            (payload.get("room") or {}).get("name")
            if isinstance(payload.get("room"), dict)
            else None
        )
        session_id = room_session_id(room_value) if isinstance(room_value, str) else None
        trace = CallTrace(
            event_id=str(row["id"]),
            provider_event_id=str(row["provider_event_id"])[:64],
            received_at=row["received_at"].isoformat(),
            room=room_value,
            session_id=str(session_id) if session_id else None,
            caller=sanitize_caller(attributes.get("sip.phoneNumber"), hash_key),
            dialed_tenant_id=dialed_tenant,
            webhook_status=row["status"],
            webhook_error=row["last_error_safe"],
            attempts=row["attempts"],
            disposition=NO_SESSION,
        )
        if row["status"] == "quarantined" or dialed_tenant is None:
            trace.disposition = UNROUTABLE
        elif row["status"] in {"failed", "received", "processing"}:
            trace.disposition = NOT_ADMITTED
        traces.append(trace)

    for trace in traces:
        if trace.session_id is None or trace.disposition == UNROUTABLE:
            continue
        session = await connection.fetchrow(
            """
            SELECT s.status::text AS status, s.outcome, s.contact_id, s.ended_at,
                   s.direction::text AS direction,
                   d.status AS intake_status, d.followup_status, d.customer_replied_at,
                   t.reference AS ticket_reference, t.stage AS ticket_stage,
                   c.reference AS case_reference
            FROM public.sessions s
            LEFT JOIN service.intake_drafts d
              ON d.tenant_id = s.tenant_id AND d.source_session_id = s.session_id
            LEFT JOIN support.tickets t
              ON t.tenant_id = s.tenant_id
             AND t.attachment_key = 'voice-session:' || s.session_id::text
            LEFT JOIN service.cases c
              ON c.tenant_id = s.tenant_id AND c.intake_draft_id = d.id
            WHERE s.session_id = $1::uuid
            """,
            trace.session_id,
        )
        if session is None:
            continue  # keeps NOT_ADMITTED / NO_SESSION
        trace.session_status = session["status"]
        trace.session_outcome = session["outcome"]
        trace.intake_status = session["intake_status"]
        trace.ticket_reference = session["ticket_reference"]
        trace.ticket_stage = session["ticket_stage"]
        trace.case_reference = session["case_reference"]
        trace.followup_status = session["followup_status"]
        trace.customer_replied = session["customer_replied_at"] is not None
        if session["direction"] != "inbound":
            trace.disposition = OUTBOUND_SKIPPED
        elif session["contact_id"] is None:
            trace.disposition = NO_CONTACT
        elif session["case_reference"] is not None:
            trace.disposition = CASE_OPENED
        elif session["ticket_reference"] is not None:
            trace.disposition = INQUIRY_OPEN
        elif session["intake_status"] is not None:
            trace.disposition = INTAKE_ONLY
        elif session["ended_at"] is None:
            trace.disposition = ACTIVE
        else:
            trace.disposition = NO_INTAKE

    report.counts = dict(Counter(trace.disposition for trace in traces))
    followups = await connection.fetch(
        """
        SELECT d.followup_status, m.status AS message_status, count(*) AS total
        FROM service.intake_drafts d
        LEFT JOIN messaging.messages m ON m.tenant_id = d.tenant_id AND m.id = d.followup_message_id
        WHERE d.source_session_id IS NOT NULL AND d.created_at >= $1 AND d.created_at < $2
          AND ($3::uuid IS NULL OR d.tenant_id = $3::uuid)
        GROUP BY 1, 2
        """,
        start,
        end,
        tenant_id,
    )
    report.followups = {
        f"{row['followup_status']}:{row['message_status'] or '-'}": row["total"]
        for row in followups
    }
    unresolved = await connection.fetchval(
        "SELECT count(*) FROM service.followup_triage WHERE resolved_at IS NULL "
        "AND ($1::uuid IS NULL OR tenant_id = $1::uuid)",
        tenant_id,
    )
    report.unresolved_reply_links = int(unresolved or 0)
    if not events:
        report.coverage_gaps.append(
            "No LiveKit webhook events in the window: either no calls, a different "
            "database, or the ledger was not reachable. This is not evidence of zero loss."
        )
    report.coverage_gaps.append(
        "Calls the SIP carrier received but never forwarded to LiveKit, or that LiveKit "
        "never delivered to this dispatcher, are invisible here; supply the provider's call "
        "records with --provider-cdr to reconcile them."
    )
    return traces, report


def recovery_dry_run(traces: list[CallTrace], window_minutes: int = 30) -> list[dict[str, Any]]:
    """Deduplicate calls needing review by caller within a short window.

    The same caller retrying within the window is one follow-up candidate; the
    same caller on a different day is a separate, legitimate request.
    """

    candidates: list[dict[str, Any]] = []
    last_by_caller: dict[tuple[str | None, str], datetime] = {}
    for trace in sorted(traces, key=lambda item: item.received_at):
        if trace.disposition not in RECOVERY_DISPOSITIONS:
            continue
        at = datetime.fromisoformat(trace.received_at)
        key = (trace.dialed_tenant_id, trace.caller)
        previous = last_by_caller.get(key)
        last_by_caller[key] = at
        if previous is not None and at - previous <= timedelta(minutes=window_minutes):
            candidates[-1]["repeat_attempts"] += 1
            continue
        candidates.append(
            {
                "tenant_id": trace.dialed_tenant_id,
                "caller": trace.caller,
                "first_seen_at": trace.received_at,
                "disposition": trace.disposition,
                "provenance": {"inbound_event_id": trace.event_id, "session_id": trace.session_id},
                "repeat_attempts": 0,
                "proposed_action": "manual review and callback decision (no automatic contact)",
            }
        )
    return candidates


def reconcile_provider(
    traces: list[CallTrace], cdr_path: Path, hash_key: bytes, tolerance_seconds: int = 120
) -> dict[str, Any]:
    """Match provider CDR rows (start_time, from, to) to webhook-traced calls."""

    unmatched: list[dict[str, str]] = []
    matched = 0
    seen = [(t.caller, datetime.fromisoformat(t.received_at)) for t in traces]
    with cdr_path.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        caller = sanitize_caller(row.get("from"), hash_key)
        try:
            started = datetime.fromisoformat(row["start_time"]).astimezone(UTC)
        except KeyError, ValueError:
            unmatched.append({"caller": caller, "reason": "unparseable_start_time"})
            continue
        if any(
            caller == other and abs((started - at).total_seconds()) <= tolerance_seconds
            for other, at in seen
        ):
            matched += 1
        else:
            unmatched.append({"caller": caller, "start_time": started.isoformat()})
    return {"provider_rows": len(rows), "matched": matched, "not_in_platform": unmatched}


async def run(arguments: argparse.Namespace) -> AuditReport:
    zone = ZoneInfo(arguments.timezone)
    until = arguments.until or datetime.now(zone).date()
    since = arguments.since or (until - timedelta(days=29))
    start, end = _window(since, until, zone)
    key = (os.environ.get("AUDIT_HASH_KEY") or "local-audit-key").encode()
    connection = await asyncpg.connect(arguments.database_url)
    try:
        async with connection.transaction(readonly=True):
            traces, report = await collect(
                connection, start, end, tenant_id=arguments.tenant, hash_key=key
            )
    finally:
        await connection.close()
    report.window.update(
        {"since": since.isoformat(), "until": until.isoformat(), "timezone": arguments.timezone}
    )
    report.recovery_dry_run = recovery_dry_run(traces)
    if arguments.provider_cdr is not None:
        report.provider_reconciliation = reconcile_provider(traces, arguments.provider_cdr, key)
    report.calls = [asdict(trace) for trace in traces]
    return report


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--database-url", default=os.environ.get("AUDIT_DATABASE_URL"))
    parser.add_argument("--since", type=date.fromisoformat)
    parser.add_argument("--until", type=date.fromisoformat)
    parser.add_argument("--timezone", default="Asia/Jerusalem")
    parser.add_argument("--tenant", type=UUID)
    parser.add_argument("--provider-cdr", type=Path)
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    if not arguments.database_url:
        parser.error("--database-url or AUDIT_DATABASE_URL is required")
    report = asyncio.run(run(arguments))
    rendered = json.dumps(asdict(report), ensure_ascii=False, indent=2)
    if arguments.output is None:
        print(rendered)
    else:
        arguments.output.write_text(rendered, encoding="utf-8")
        print(
            json.dumps(
                {"counts": report.counts, "recovery_candidates": len(report.recovery_dry_run)},
                indent=2,
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
