"""Canonical read-only voice surface backed by retained Or-on sessions."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal, Protocol, cast
from uuid import NAMESPACE_URL, UUID, uuid5
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from oron_common import E164, CallUsage, Direction
from oron_db import make_engine, make_sessionmaker, set_tenant
from oron_flows.components import SPEC_VERSION, export_catalog
from oron_flows.compose import Composition, expand
from oron_sessions.models import Session, SessionEvent, SessionStatus
from oron_tenancy.models import Flow, PhoneNumber
from pydantic import BaseModel, Field
from sqlalchemy import bindparam, func, select, text
from sqlalchemy.dialects.postgresql import JSONB, insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from sqlmodel import col

from control_api.auth import (
    InvalidServiceAssertion,
    ServiceAssertionVerifier,
    ServicePrincipal,
)

_SESSION_TABLE = cast(Any, Session).__table__
_SESSION_EVENT_TABLE = cast(Any, SessionEvent).__table__
_PHONE_NUMBER_TABLE = cast(Any, PhoneNumber).__table__
_FLOW_TABLE = cast(Any, Flow).__table__

_DEFAULT_CALLING_HOURS = {0: [9, 18], 1: [9, 18], 2: [9, 18], 3: [9, 18], 4: [9, 14], 6: [9, 18]}


class VoiceSessionSummary(BaseModel):
    session_id: UUID
    contact_id: UUID | None
    platform_campaign_id: UUID | None
    provider: str
    direction: Direction
    status: SessionStatus
    answered: bool | None
    outcome: str | None
    created_at: dt.datetime
    ended_at: dt.datetime | None


class VoiceSessionList(BaseModel):
    items: list[VoiceSessionSummary]


class VoiceSessionEvent(BaseModel):
    sequence: int
    event_type: str
    payload: dict[str, object]
    occurred_at: dt.datetime


class VoiceSessionDetail(VoiceSessionSummary):
    events: list[VoiceSessionEvent]
    usage: CallUsage
    recording_object_id: UUID | None
    transcript_object_id: UUID | None


class VoiceSessionLookup(BaseModel):
    session_id: UUID


class PhoneNumberSummary(BaseModel):
    id: UUID
    e164: str
    flow_id: UUID
    dispatch_rule_id: str
    admission: Literal["simulated", "provider_disabled", "drifted"]


class PhoneNumberList(BaseModel):
    items: list[PhoneNumberSummary]


class RegisterPhoneNumberRequest(BaseModel):
    e164: E164
    flow_id: UUID
    allowed_addresses: Annotated[list[str], Field(min_length=1)]
    mode: Literal["simulator"] = "simulator"


class ReconciliationReport(BaseModel):
    ok: bool
    provider_enabled: bool = False
    findings: list[str]


class FlowSummary(BaseModel):
    flow_id: UUID
    name: str
    language: str
    latest_version: int
    packaged: bool


class FlowList(BaseModel):
    items: list[FlowSummary]


class FlowDocumentRequest(BaseModel):
    source: dict[str, object]


class FlowValidationResult(BaseModel):
    valid: bool
    errors: list[str]
    normalized: dict[str, object] | None = None


class FlowPublishResult(BaseModel):
    flow: FlowSummary
    created: bool


class ComponentCatalog(BaseModel):
    spec_version: str
    components: list[dict[str, object]]


class VoiceCampaignCreate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=160)]
    flow_id: UUID
    max_concurrent: Annotated[int, Field(ge=1, le=20)] = 1
    max_attempts: Annotated[int, Field(ge=1, le=5)] = 1
    timezone: str = "Asia/Jerusalem"
    weekday_hours: dict[int, list[int]] = Field(
        default_factory=lambda: dict(_DEFAULT_CALLING_HOURS)
    )


class VoiceCampaignSummary(BaseModel):
    id: UUID
    name: str
    status: str
    flow_id: UUID
    max_concurrent: int
    max_attempts: int
    eligible_contacts: int
    completed_calls: int
    created_at: dt.datetime


class VoiceCampaignList(BaseModel):
    items: list[VoiceCampaignSummary]


class VoiceCampaignRun(BaseModel):
    campaign_id: UUID


class VoiceCampaignRunResult(BaseModel):
    campaign: VoiceCampaignSummary
    created_calls: int
    skipped_contacts: int


class SimulatedCallRequest(BaseModel):
    contact_id: UUID
    idempotency_key: Annotated[
        str,
        Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$"),
    ]
    mode: Literal["simulator"] = "simulator"
    scenario: Literal["completed", "no_answer", "failed", "cancelled"] = "completed"


class SimulatedCallResult(BaseModel):
    session: VoiceSessionSummary
    created: bool
    event_types: list[str]


class RealTelephonyDenied(RuntimeError):
    """A safe denial that contains no credentials or provider details."""


class SimulatedCallConflict(ValueError):
    """An idempotency key was reused for a different logical command."""


def require_real_telephony_authorization(*, enabled: bool, explicit_approval: bool) -> None:
    """Enforce both real-action gates before a future provider adapter is built."""

    if not enabled:
        raise RealTelephonyDenied("real telephony is disabled")
    if not explicit_approval:
        raise RealTelephonyDenied("real telephony requires explicit per-action approval")


class VoiceRepository(Protocol):
    async def list_sessions(self, principal: ServicePrincipal) -> list[VoiceSessionSummary]: ...

    async def get_session(
        self, principal: ServicePrincipal, session_id: UUID
    ) -> VoiceSessionDetail | None: ...

    async def simulate_call(
        self, principal: ServicePrincipal, command: SimulatedCallRequest
    ) -> SimulatedCallResult: ...

    async def list_phone_numbers(self, principal: ServicePrincipal) -> list[PhoneNumberSummary]: ...

    async def register_phone_number(
        self, principal: ServicePrincipal, command: RegisterPhoneNumberRequest
    ) -> PhoneNumberSummary: ...

    async def reconcile_phone_numbers(
        self, principal: ServicePrincipal
    ) -> ReconciliationReport: ...

    async def list_flows(self, principal: ServicePrincipal) -> list[FlowSummary]: ...

    async def validate_flow(self, command: FlowDocumentRequest) -> FlowValidationResult: ...

    async def publish_flow(
        self, principal: ServicePrincipal, command: FlowDocumentRequest
    ) -> FlowPublishResult: ...

    async def list_campaigns(self, principal: ServicePrincipal) -> list[VoiceCampaignSummary]: ...

    async def create_campaign(
        self, principal: ServicePrincipal, command: VoiceCampaignCreate
    ) -> VoiceCampaignSummary: ...

    async def run_campaign(
        self, principal: ServicePrincipal, campaign_id: UUID
    ) -> VoiceCampaignRunResult: ...

    async def close(self) -> None: ...


class PostgresVoiceRepository:
    """One role-scoped repository; every request sets transaction-local identity."""

    def __init__(self, database_url: str, *, engine: AsyncEngine | None = None) -> None:
        normalized = database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
        self._engine = engine if engine is not None else make_engine(normalized)
        self._sessionmaker = make_sessionmaker(self._engine)

    async def list_sessions(self, principal: ServicePrincipal) -> list[VoiceSessionSummary]:
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, principal.tenant_id)
            await database.execute(
                select(func.set_config("app.current_user", str(principal.user_id), True))
            )
            await database.execute(
                select(func.set_config("app.current_role", principal.role, True))
            )
            rows = list(
                (
                    await database.execute(
                        select(Session)
                        .order_by(col(Session.created_at).desc(), col(Session.session_id).desc())
                        .limit(50)
                    )
                ).scalars()
            )
            return [_summary(row) for row in rows]

    async def get_session(
        self, principal: ServicePrincipal, session_id: UUID
    ) -> VoiceSessionDetail | None:
        async with self._sessionmaker() as database, database.begin():
            await self._scope(database, principal)
            row = (
                await database.execute(select(Session).where(col(Session.session_id) == session_id))
            ).scalar_one_or_none()
            if row is None:
                return None
            events = list(
                (
                    await database.execute(
                        select(SessionEvent)
                        .where(col(SessionEvent.session_id) == session_id)
                        .order_by(col(SessionEvent.sequence))
                    )
                ).scalars()
            )
            return VoiceSessionDetail(
                **_summary(row).model_dump(),
                events=[
                    VoiceSessionEvent(
                        sequence=event.sequence,
                        event_type=event.event_type,
                        payload=event.payload,
                        occurred_at=event.occurred_at,
                    )
                    for event in events
                ],
                usage=CallUsage.model_validate(row, from_attributes=True),
                recording_object_id=row.recording_object_id,
                transcript_object_id=row.transcript_object_id,
            )

    async def _scope(self, database: Any, principal: ServicePrincipal) -> None:
        await set_tenant(database, principal.tenant_id)
        await database.execute(
            select(func.set_config("app.current_user", str(principal.user_id), True))
        )
        await database.execute(select(func.set_config("app.current_role", principal.role, True)))

    async def _audit(
        self,
        database: Any,
        principal: ServicePrincipal,
        *,
        action: str,
        target_type: str,
        target_id: UUID,
        metadata: dict[str, object],
    ) -> None:
        statement = text(
            """
            INSERT INTO audit.records
              (tenant_id, actor_user_id, action, target_type, target_id, metadata)
            VALUES (:tenant_id, :actor_user_id, :action, :target_type, :target_id, :metadata)
            """
        ).bindparams(bindparam("metadata", type_=JSONB))
        await database.execute(
            statement,
            {
                "tenant_id": principal.tenant_id,
                "actor_user_id": principal.user_id,
                "action": action,
                "target_type": target_type,
                "target_id": target_id,
                "metadata": metadata,
            },
        )

    @asynccontextmanager
    async def simulation_transaction(
        self, existing: AsyncSession | None = None
    ) -> AsyncIterator[AsyncSession]:
        """Allow a durable job and its simulator effects to commit atomically."""
        if existing is not None:
            yield existing
        else:
            async with self._sessionmaker() as database, database.begin():
                yield database

    async def simulate_call(
        self,
        principal: ServicePrincipal,
        command: SimulatedCallRequest,
        *,
        transaction: AsyncSession | None = None,
    ) -> SimulatedCallResult:
        session_id = uuid5(
            NAMESPACE_URL,
            f"or-on-platform:voice-simulator:{principal.tenant_id}:{command.idempotency_key}",
        )
        now = dt.datetime.now(dt.UTC)
        transcript = "Fictional simulator transcript."
        transcript_object_id = uuid5(NAMESPACE_URL, f"or-on-platform:transcript:{session_id}")
        successful_events: tuple[tuple[str, dict[str, object]], ...] = (
            ("voice.call.requested.v1", {"mode": "simulator"}),
            ("voice.call.started.v1", {"mode": "simulator"}),
            ("voice.call.answered.v1", {"answered": True}),
            (
                "voice.call.transcript.updated.v1",
                {"text": transcript},
            ),
            (
                "voice.call.outcome.recorded.v1",
                {"outcome": "simulator_completed"},
            ),
            (
                "voice.call.usage.recorded.v1",
                {"call_seconds": 12.0, "provider_latency_ms": 24},
            ),
            ("voice.call.ended.v1", {"answered": True}),
        )
        scenario_events: dict[str, tuple[tuple[str, dict[str, object]], ...]] = {
            "completed": successful_events,
            "no_answer": (
                ("voice.call.requested.v1", {"mode": "simulator"}),
                ("voice.call.started.v1", {"mode": "simulator"}),
                ("voice.call.ended.v1", {"answered": False, "outcome": "no_answer"}),
            ),
            "failed": (
                ("voice.call.requested.v1", {"mode": "simulator"}),
                ("voice.call.failed.v1", {"reason": "fixture_failure"}),
            ),
            "cancelled": (
                ("voice.call.requested.v1", {"mode": "simulator"}),
                ("voice.call.started.v1", {"mode": "simulator"}),
                ("voice.call.cancelled.v1", {"reason": "operator_request"}),
                ("voice.call.ended.v1", {"answered": False, "outcome": "cancelled"}),
            ),
        }
        event_payloads = scenario_events[command.scenario]
        status = SessionStatus.FAILED if command.scenario == "failed" else SessionStatus.ENDED
        answered = command.scenario == "completed"
        outcome = {
            "completed": "simulator_completed",
            "no_answer": "no_answer",
            "failed": "simulator_failure",
            "cancelled": "cancelled",
        }[command.scenario]
        async with self.simulation_transaction(transaction) as database:
            await set_tenant(database, principal.tenant_id)
            await database.execute(
                select(func.set_config("app.current_user", str(principal.user_id), True))
            )
            await database.execute(
                select(func.set_config("app.current_role", principal.role, True))
            )
            await database.execute(
                text(
                    """
                    INSERT INTO objects.object_metadata
                      (id, tenant_id, created_by_user_id, owner_type, owner_id, category,
                       content_type, byte_size, checksum, storage_backend, storage_key, status)
                    VALUES (:id, :tenant_id, :user_id, 'voice_session', :session_id,
                            'transcript', 'text/plain; charset=utf-8', :byte_size, :checksum,
                            'local', :storage_key, 'pending')
                    ON CONFLICT (id) DO NOTHING
                    """
                ),
                {
                    "id": transcript_object_id,
                    "tenant_id": principal.tenant_id,
                    "user_id": principal.user_id,
                    "session_id": session_id,
                    "byte_size": len(transcript.encode()),
                    "checksum": hashlib.sha256(transcript.encode()).hexdigest(),
                    "storage_key": f"simulator/voice/{session_id}/transcript.txt",
                },
            )
            inserted = await database.execute(
                insert(_SESSION_TABLE)
                .values(
                    session_id=session_id,
                    tenant_id=principal.tenant_id,
                    provider="simulator",
                    direction=Direction.OUTBOUND,
                    room=f"simulator:{session_id}",
                    flow_id=UUID(int=0),
                    status=status,
                    answered=answered,
                    outcome=outcome,
                    ended_at=now,
                    contact_id=command.contact_id,
                    initiated_by_user_id=principal.user_id,
                    provider_call_id=f"simulator:{session_id}",
                    idempotency_key=command.idempotency_key,
                    transcript_object_id=transcript_object_id,
                    call_seconds=12.0,
                    carrier="",
                    llm_model="simulator",
                    tts_model="simulator",
                    stt_audio_seconds=12.0,
                )
                .on_conflict_do_nothing(index_elements=[_SESSION_TABLE.c.session_id])
                .returning(_SESSION_TABLE.c.session_id)
            )
            created = inserted.scalar_one_or_none() is not None
            if created:
                await database.execute(
                    insert(_SESSION_EVENT_TABLE),
                    [
                        {
                            "id": uuid5(
                                NAMESPACE_URL,
                                f"or-on-platform:voice-event:{session_id}:{sequence}",
                            ),
                            "tenant_id": principal.tenant_id,
                            "session_id": session_id,
                            "sequence": sequence,
                            "event_type": event_type,
                            "version": 1,
                            "provider": "simulator",
                            "idempotency_key": f"{command.idempotency_key}:{sequence}",
                            "payload": payload,
                            "occurred_at": now + dt.timedelta(milliseconds=sequence),
                        }
                        for sequence, (event_type, payload) in enumerate(event_payloads)
                    ],
                )
                outbox_statement = text(
                    """
                    INSERT INTO ops.outbox_events
                      (tenant_id, event_type, aggregate_type, aggregate_id, payload)
                    VALUES (:tenant_id, :event_type, 'voice_session', :session_id, :payload)
                    """
                ).bindparams(bindparam("payload", type_=JSONB))
                await database.execute(
                    outbox_statement,
                    [
                        {
                            "tenant_id": principal.tenant_id,
                            "event_type": event_type,
                            "session_id": session_id,
                            "payload": {"session_id": str(session_id), **payload},
                        }
                        for event_type, payload in event_payloads
                    ],
                )
                await self._audit(
                    database,
                    principal,
                    action="voice.simulated_call.completed",
                    target_type="voice_session",
                    target_id=session_id,
                    metadata={"provider": "simulator", "scenario": command.scenario},
                )
            row = (
                await database.execute(select(Session).where(col(Session.session_id) == session_id))
            ).scalar_one()
            if row.contact_id != command.contact_id:
                raise SimulatedCallConflict(
                    "idempotency key is already bound to another simulated call"
                )
            if row.outcome != outcome:
                raise SimulatedCallConflict(
                    "idempotency key is already bound to another simulator scenario"
                )
            return SimulatedCallResult(
                session=_summary(row),
                created=created,
                event_types=[event_type for event_type, _ in event_payloads],
            )

    async def list_phone_numbers(self, principal: ServicePrincipal) -> list[PhoneNumberSummary]:
        async with self._sessionmaker() as database, database.begin():
            await self._scope(database, principal)
            rows = list(
                (
                    await database.execute(select(PhoneNumber).order_by(col(PhoneNumber.e164)))
                ).scalars()
            )
            return [_phone_summary(row) for row in rows]

    async def register_phone_number(
        self, principal: ServicePrincipal, command: RegisterPhoneNumberRequest
    ) -> PhoneNumberSummary:
        if any(
            address.strip() in {"", "0.0.0.0/0", "::/0"} for address in command.allowed_addresses
        ):
            raise ValueError("SIP admission ACL must contain only restricted carrier networks")
        async with self._sessionmaker() as database, database.begin():
            await self._scope(database, principal)
            known_flow = await database.scalar(
                select(func.count())
                .select_from(_FLOW_TABLE)
                .where(
                    _FLOW_TABLE.c.flow_id == command.flow_id,
                    (_FLOW_TABLE.c.tenant_id == principal.tenant_id)
                    | (_FLOW_TABLE.c.tenant_id.is_(None)),
                )
            )
            if not known_flow:
                raise LookupError("unknown voice flow")
            identifier = uuid5(
                NAMESPACE_URL,
                f"or-on-platform:simulated-did:{principal.tenant_id}:{command.e164}",
            )
            statement = (
                insert(_PHONE_NUMBER_TABLE)
                .values(
                    id=identifier,
                    tenant_id=principal.tenant_id,
                    e164=str(command.e164),
                    flow_id=command.flow_id,
                    dispatch_rule_id=f"simulator:{identifier}",
                )
                .on_conflict_do_nothing(index_elements=[_PHONE_NUMBER_TABLE.c.e164])
            )
            await database.execute(statement)
            row = (
                await database.execute(
                    select(PhoneNumber).where(col(PhoneNumber.e164) == str(command.e164))
                )
            ).scalar_one()
            if row.tenant_id != principal.tenant_id or row.flow_id != command.flow_id:
                raise SimulatedCallConflict("phone number is already registered differently")
            await self._audit(
                database,
                principal,
                action="voice.did.registered",
                target_type="phone_number",
                target_id=row.id,
                metadata={"mode": "simulator"},
            )
            return _phone_summary(row)

    async def reconcile_phone_numbers(self, principal: ServicePrincipal) -> ReconciliationReport:
        numbers = await self.list_phone_numbers(principal)
        findings = [
            f"{number.e164}: provider comparison disabled; canonical simulator admission retained"
            for number in numbers
        ]
        return ReconciliationReport(ok=True, findings=findings)

    async def list_flows(self, principal: ServicePrincipal) -> list[FlowSummary]:
        async with self._sessionmaker() as database, database.begin():
            await self._scope(database, principal)
            statement = (
                select(Flow)
                .where((col(Flow.tenant_id) == principal.tenant_id) | col(Flow.tenant_id).is_(None))
                .distinct(col(Flow.flow_id))
                .order_by(
                    col(Flow.flow_id), col(Flow.tenant_id).is_(None), col(Flow.version).desc()
                )
            )
            rows = list((await database.execute(statement)).scalars())
            return [_flow_summary(row) for row in rows]

    async def validate_flow(self, command: FlowDocumentRequest) -> FlowValidationResult:
        try:
            composition = Composition.model_validate(command.source)
            specification = expand(composition)
        except (KeyError, ValueError) as error:
            return FlowValidationResult(valid=False, errors=[str(error)])
        return FlowValidationResult(
            valid=True,
            errors=[],
            normalized={
                "source": composition.model_dump(mode="json"),
                "spec": specification.model_dump(mode="json"),
                "components_version": SPEC_VERSION,
            },
        )

    async def publish_flow(
        self, principal: ServicePrincipal, command: FlowDocumentRequest
    ) -> FlowPublishResult:
        validation = await self.validate_flow(command)
        if not validation.valid or validation.normalized is None:
            raise ValueError("voice flow is invalid")
        source = cast(dict[str, object], validation.normalized["source"])
        spec = cast(dict[str, object], validation.normalized["spec"])
        composition = Composition.model_validate(source)
        async with self._sessionmaker() as database, database.begin():
            await self._scope(database, principal)
            inserted = await database.execute(
                insert(_FLOW_TABLE)
                .values(
                    flow_id=composition.flow.id,
                    version=composition.flow.version,
                    tenant_id=principal.tenant_id,
                    source=source,
                    spec=spec,
                    components_version=SPEC_VERSION,
                )
                .on_conflict_do_nothing(
                    index_elements=[_FLOW_TABLE.c.flow_id, _FLOW_TABLE.c.version]
                )
                .returning(_FLOW_TABLE.c.flow_id)
            )
            created = inserted.scalar_one_or_none() is not None
            row = (
                await database.execute(
                    select(Flow).where(
                        col(Flow.flow_id) == composition.flow.id,
                        col(Flow.version) == composition.flow.version,
                    )
                )
            ).scalar_one()
            if row.tenant_id != principal.tenant_id or row.source != source or row.spec != spec:
                raise SimulatedCallConflict("published flow versions are immutable")
            if created:
                await self._audit(
                    database,
                    principal,
                    action="voice.flow.published",
                    target_type="voice_flow",
                    target_id=row.flow_id,
                    metadata={"version": row.version},
                )
            return FlowPublishResult(flow=_flow_summary(row), created=created)

    async def list_campaigns(self, principal: ServicePrincipal) -> list[VoiceCampaignSummary]:
        async with self._sessionmaker() as database, database.begin():
            await self._scope(database, principal)
            rows = (
                await database.execute(
                    text(
                        """
                        SELECT c.id, c.name, c.status, c.voice_flow_id, c.max_concurrent,
                               c.max_attempts, c.created_at,
                               (SELECT count(*) FROM crm.contacts contact
                                WHERE contact.tenant_id = c.tenant_id
                                  AND contact.lifecycle_status = 'active'
                                  AND contact.voice_consent = 'granted'
                                  AND EXISTS (
                                    SELECT 1 FROM crm.contact_channel_identities identity
                                    WHERE identity.tenant_id = contact.tenant_id
                                      AND identity.contact_id = contact.id
                                      AND identity.channel IN ('phone', 'whatsapp')
                                      AND identity.normalized_value IS NOT NULL
                                      AND identity.validation_status <> 'invalid'
                                  )) AS eligible_contacts,
                               (SELECT count(*) FROM sessions session
                                WHERE session.tenant_id = c.tenant_id
                                  AND session.platform_campaign_id = c.id
                                  AND session.status = 'ended') AS completed_calls
                        FROM platform.campaigns c
                        WHERE c.channel = 'voice'
                        ORDER BY c.created_at DESC, c.id DESC
                        """
                    )
                )
            ).mappings()
            return [_campaign_summary(row) for row in rows]

    async def create_campaign(
        self, principal: ServicePrincipal, command: VoiceCampaignCreate
    ) -> VoiceCampaignSummary:
        _validate_calling_policy(command.timezone, command.weekday_hours)
        async with self._sessionmaker() as database, database.begin():
            await self._scope(database, principal)
            known_flow = await database.scalar(
                select(func.count())
                .select_from(_FLOW_TABLE)
                .where(
                    _FLOW_TABLE.c.flow_id == command.flow_id,
                    (_FLOW_TABLE.c.tenant_id == principal.tenant_id)
                    | (_FLOW_TABLE.c.tenant_id.is_(None)),
                )
            )
            if not known_flow:
                raise LookupError("unknown voice flow")
            campaign_id = uuid5(
                NAMESPACE_URL,
                f"or-on-platform:voice-campaign:{principal.tenant_id}:{command.name}",
            )
            await database.execute(
                text(
                    """
                    INSERT INTO platform.campaigns
                      (id, tenant_id, name, status, channel, created_by_user_id,
                       voice_flow_id, max_concurrent, max_attempts, timezone, weekday_hours)
                    VALUES (:id, :tenant_id, :name, 'draft', 'voice', :user_id,
                            :flow_id, :max_concurrent, :max_attempts, :timezone,
                            CAST(:weekday_hours AS jsonb))
                    ON CONFLICT (id) DO NOTHING
                    """
                ),
                {
                    "id": campaign_id,
                    "tenant_id": principal.tenant_id,
                    "name": command.name,
                    "user_id": principal.user_id,
                    "flow_id": command.flow_id,
                    "max_concurrent": command.max_concurrent,
                    "max_attempts": command.max_attempts,
                    "timezone": command.timezone,
                    "weekday_hours": json.dumps(command.weekday_hours),
                },
            )
            await self._audit(
                database,
                principal,
                action="voice.campaign.created",
                target_type="campaign",
                target_id=campaign_id,
                metadata={"mode": "simulator"},
            )
        campaigns = await self.list_campaigns(principal)
        return next(campaign for campaign in campaigns if campaign.id == campaign_id)

    async def run_campaign(
        self, principal: ServicePrincipal, campaign_id: UUID
    ) -> VoiceCampaignRunResult:
        async with self._sessionmaker() as database, database.begin():
            await self._scope(database, principal)
            campaign = (
                (
                    await database.execute(
                        text(
                            "SELECT * FROM platform.campaigns "
                            "WHERE id = :id AND channel = 'voice' FOR UPDATE"
                        ),
                        {"id": campaign_id},
                    )
                )
                .mappings()
                .one_or_none()
            )
            if campaign is None:
                raise LookupError("unknown voice campaign")
            if not _calling_window_open(campaign["timezone"], campaign["weekday_hours"]):
                raise ValueError("voice campaign calling window is closed")
            contacts = list(
                (
                    await database.execute(
                        text(
                            """
                            SELECT contact.id
                            FROM crm.contacts contact
                            WHERE contact.lifecycle_status = 'active'
                              AND contact.voice_consent = 'granted'
                              AND EXISTS (
                                SELECT 1 FROM crm.contact_channel_identities identity
                                WHERE identity.contact_id = contact.id
                                  AND identity.channel IN ('phone', 'whatsapp')
                                  AND identity.normalized_value IS NOT NULL
                                  AND identity.validation_status <> 'invalid'
                              )
                            ORDER BY contact.id
                            """
                        )
                    )
                ).scalars()
            )
            await database.execute(
                text("UPDATE platform.campaigns SET status = 'running' WHERE id = :id"),
                {"id": campaign_id},
            )
        created = 0
        for contact_id in contacts:
            result = await self.simulate_call(
                principal,
                SimulatedCallRequest(
                    contact_id=contact_id,
                    idempotency_key=f"campaign:{campaign_id}:{contact_id}",
                ),
            )
            if result.created:
                async with self._sessionmaker() as database, database.begin():
                    await self._scope(database, principal)
                    await database.execute(
                        text(
                            "UPDATE sessions SET platform_campaign_id = :campaign_id "
                            "WHERE session_id = :session_id"
                        ),
                        {"campaign_id": campaign_id, "session_id": result.session.session_id},
                    )
                created += 1
        async with self._sessionmaker() as database, database.begin():
            await self._scope(database, principal)
            await database.execute(
                text(
                    "UPDATE platform.campaigns SET status = 'completed', completed_at = now(), "
                    "updated_at = now() WHERE id = :id"
                ),
                {"id": campaign_id},
            )
            await self._audit(
                database,
                principal,
                action="voice.campaign.completed",
                target_type="campaign",
                target_id=campaign_id,
                metadata={
                    "created_calls": created,
                    "skipped_contacts": len(contacts) - created,
                },
            )
        summary = next(
            item for item in await self.list_campaigns(principal) if item.id == campaign_id
        )
        return VoiceCampaignRunResult(
            campaign=summary,
            created_calls=created,
            skipped_contacts=len(contacts) - created,
        )

    async def close(self) -> None:
        await self._engine.dispose()


def _summary(row: Session) -> VoiceSessionSummary:
    if row.created_at is None:
        raise RuntimeError("persisted session is missing created_at")
    return VoiceSessionSummary(
        session_id=row.session_id,
        contact_id=row.contact_id,
        platform_campaign_id=row.platform_campaign_id,
        provider=row.provider,
        direction=row.direction,
        status=row.status,
        answered=row.answered,
        outcome=row.outcome,
        created_at=row.created_at,
        ended_at=row.ended_at,
    )


def _phone_summary(row: PhoneNumber) -> PhoneNumberSummary:
    simulated = row.dispatch_rule_id.startswith("simulator:")
    return PhoneNumberSummary(
        id=row.id,
        e164=str(row.e164),
        flow_id=row.flow_id,
        dispatch_rule_id=row.dispatch_rule_id,
        admission="simulated" if simulated else "provider_disabled",
    )


def _flow_summary(row: Flow) -> FlowSummary:
    flow = row.source.get("flow", {})
    return FlowSummary(
        flow_id=row.flow_id,
        name=str(flow.get("name") or row.flow_id),
        language=str(flow.get("language") or "he"),
        latest_version=row.version,
        packaged=row.tenant_id is None,
    )


def _campaign_summary(row: Any) -> VoiceCampaignSummary:
    return VoiceCampaignSummary(
        id=row["id"],
        name=row["name"],
        status=row["status"],
        flow_id=row["voice_flow_id"],
        max_concurrent=row["max_concurrent"],
        max_attempts=row["max_attempts"],
        eligible_contacts=row["eligible_contacts"],
        completed_calls=row["completed_calls"],
        created_at=row["created_at"],
    )


def _validate_calling_policy(timezone: str, weekday_hours: dict[int, list[int]]) -> None:
    ZoneInfo(timezone)
    if not weekday_hours:
        raise ValueError("at least one calling day is required")
    for weekday, hours in weekday_hours.items():
        if weekday not in range(7) or len(hours) != 2 or not 0 <= hours[0] < hours[1] <= 24:
            raise ValueError("calling hours must map weekdays 0..6 to [start, end]")


def _calling_window_open(timezone: str, weekday_hours: dict[str, list[int]]) -> bool:
    now = dt.datetime.now(ZoneInfo(timezone))
    hours = weekday_hours.get(str(now.weekday()))
    return hours is not None and hours[0] <= now.hour < hours[1]


def create_voice_router(
    repository: VoiceRepository | None,
    verifier: ServiceAssertionVerifier | None,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/voice", tags=["voice"])
    bearer = HTTPBearer(auto_error=False)

    async def require_voice_read(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    ) -> ServicePrincipal:
        if repository is None or verifier is None:
            raise HTTPException(status_code=503, detail="voice API is not configured")
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="authentication required")
        try:
            principal = verifier.verify(credentials.credentials)
        except InvalidServiceAssertion:
            raise HTTPException(status_code=401, detail="invalid service assertion") from None
        if principal.capability not in {"voice:read", "voice:write"}:
            raise HTTPException(status_code=403, detail="voice capability required")
        return principal

    async def require_voice_write(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    ) -> ServicePrincipal:
        principal = await require_voice_read(credentials)
        if principal.capability != "voice:write":
            raise HTTPException(status_code=403, detail="voice write capability required")
        return principal

    async def configured_repository() -> VoiceRepository:
        if repository is None:
            raise HTTPException(status_code=503, detail="voice API is not configured")
        return repository

    @router.get(
        "/sessions",
        response_model=VoiceSessionList,
        operation_id="list_voice_sessions",
    )
    async def list_voice_sessions(
        principal: ServicePrincipal = Depends(require_voice_read),
        store: VoiceRepository = Depends(configured_repository),
    ) -> VoiceSessionList:
        return VoiceSessionList(items=await store.list_sessions(principal))

    @router.post(
        "/session-detail",
        response_model=VoiceSessionDetail,
        operation_id="get_voice_session",
    )
    async def get_voice_session(
        query: VoiceSessionLookup,
        principal: ServicePrincipal = Depends(require_voice_read),
        store: VoiceRepository = Depends(configured_repository),
    ) -> VoiceSessionDetail:
        detail = await store.get_session(principal, query.session_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="voice session not found")
        return detail

    @router.post(
        "/simulated-calls",
        response_model=SimulatedCallResult,
        operation_id="simulate_voice_call",
    )
    async def simulate_voice_call(
        command: SimulatedCallRequest,
        principal: ServicePrincipal = Depends(require_voice_write),
        store: VoiceRepository = Depends(configured_repository),
    ) -> SimulatedCallResult:
        try:
            return await store.simulate_call(principal, command)
        except (IntegrityError, SimulatedCallConflict) as error:
            # Foreign-key and persistence failures remain an opaque service
            # response; neither contact data nor database details cross the API.
            raise HTTPException(
                status_code=409, detail="simulated call could not be created"
            ) from error

    @router.get(
        "/phone-numbers",
        response_model=PhoneNumberList,
        operation_id="list_voice_phone_numbers",
    )
    async def list_voice_phone_numbers(
        principal: ServicePrincipal = Depends(require_voice_read),
        store: VoiceRepository = Depends(configured_repository),
    ) -> PhoneNumberList:
        return PhoneNumberList(items=await store.list_phone_numbers(principal))

    @router.post(
        "/phone-numbers",
        response_model=PhoneNumberSummary,
        operation_id="register_voice_phone_number",
    )
    async def register_voice_phone_number(
        command: RegisterPhoneNumberRequest,
        principal: ServicePrincipal = Depends(require_voice_write),
        store: VoiceRepository = Depends(configured_repository),
    ) -> PhoneNumberSummary:
        try:
            return await store.register_phone_number(principal, command)
        except LookupError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @router.get(
        "/phone-numbers/reconciliation",
        response_model=ReconciliationReport,
        operation_id="reconcile_voice_phone_numbers",
    )
    async def reconcile_voice_phone_numbers(
        principal: ServicePrincipal = Depends(require_voice_read),
        store: VoiceRepository = Depends(configured_repository),
    ) -> ReconciliationReport:
        return await store.reconcile_phone_numbers(principal)

    @router.get(
        "/component-catalog",
        response_model=ComponentCatalog,
        operation_id="get_voice_component_catalog",
    )
    async def get_voice_component_catalog(
        _: ServicePrincipal = Depends(require_voice_read),
    ) -> ComponentCatalog:
        return ComponentCatalog.model_validate(export_catalog())

    @router.get("/flows", response_model=FlowList, operation_id="list_voice_flows")
    async def list_voice_flows(
        principal: ServicePrincipal = Depends(require_voice_read),
        store: VoiceRepository = Depends(configured_repository),
    ) -> FlowList:
        return FlowList(items=await store.list_flows(principal))

    @router.post(
        "/flows/validate",
        response_model=FlowValidationResult,
        operation_id="validate_voice_flow",
    )
    async def validate_voice_flow(
        command: FlowDocumentRequest,
        _: ServicePrincipal = Depends(require_voice_write),
        store: VoiceRepository = Depends(configured_repository),
    ) -> FlowValidationResult:
        return await store.validate_flow(command)

    @router.post(
        "/flows/publish",
        response_model=FlowPublishResult,
        operation_id="publish_voice_flow",
    )
    async def publish_voice_flow(
        command: FlowDocumentRequest,
        principal: ServicePrincipal = Depends(require_voice_write),
        store: VoiceRepository = Depends(configured_repository),
    ) -> FlowPublishResult:
        try:
            return await store.publish_flow(principal, command)
        except SimulatedCallConflict as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.get("/campaigns", response_model=VoiceCampaignList, operation_id="list_voice_campaigns")
    async def list_voice_campaigns(
        principal: ServicePrincipal = Depends(require_voice_read),
        store: VoiceRepository = Depends(configured_repository),
    ) -> VoiceCampaignList:
        return VoiceCampaignList(items=await store.list_campaigns(principal))

    @router.post(
        "/campaigns", response_model=VoiceCampaignSummary, operation_id="create_voice_campaign"
    )
    async def create_voice_campaign(
        command: VoiceCampaignCreate,
        principal: ServicePrincipal = Depends(require_voice_write),
        store: VoiceRepository = Depends(configured_repository),
    ) -> VoiceCampaignSummary:
        try:
            return await store.create_campaign(principal, command)
        except (LookupError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.post(
        "/campaigns/run",
        response_model=VoiceCampaignRunResult,
        operation_id="run_voice_campaign",
    )
    async def run_voice_campaign(
        command: VoiceCampaignRun,
        principal: ServicePrincipal = Depends(require_voice_write),
        store: VoiceRepository = Depends(configured_repository),
    ) -> VoiceCampaignRunResult:
        try:
            return await store.run_campaign(principal, command.campaign_id)
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    return router
