"""Retained one-agent-per-room dispatcher with canonical safety adaptations."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Literal, Protocol
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from livekit.protocol.models import ParticipantInfo
from oron_common import CallContext, Direction, validate_e164
from oron_sessions import SessionStatus
from pydantic import BaseModel, ConfigDict, SkipValidation

from oron_dispatcher.sip_client import SipClient
from oron_dispatcher.tenancy_client import PhoneResolution

logger = logging.getLogger(__name__)


class PersistenceUnavailable(RuntimeError):
    """The dispatcher cannot durably record a lifecycle transition."""


class AgentStartupUnavailable(RuntimeError):
    """The provider-backed conversational agent failed before dialing."""


class IdempotencyConflict(RuntimeError):
    """A previously admitted call key was reused with different parameters."""


class BotHandle(Protocol):
    async def cancel(self) -> None: ...

    def observe_completion(self, callback: Callable[[BaseException | None], None]) -> None: ...


class SessionPersistence(Protocol):
    async def begin(self, context: CallContext, *, room: str, idempotency_key: str) -> bool: ...

    async def finalize(self, context: CallContext, *, status: SessionStatus) -> bool: ...

    async def ready(self) -> bool: ...


class DispatcherConfig(Protocol):
    room_prefix: str
    bot_identity: str


LaunchBot = Callable[[str, CallContext, Mapping[str, object] | None], Awaitable[BotHandle]]
ResolvePhone = Callable[[str], Awaitable[PhoneResolution | None]]
HangupRoom = Callable[[str], Awaitable[None]]
MintToken = Callable[[str, str], str]


class _Active(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    context: CallContext
    handle: SkipValidation[BotHandle]


class BrowserCall(BaseModel):
    room: str
    session_id: UUID
    token: str


class DispatchResult(BaseModel):
    session_id: UUID
    room: str
    created: bool


class ActiveCall(BaseModel):
    room: str
    session_id: UUID
    direction: Direction
    from_number: str | None
    to_number: str | None
    flow_id: UUID
    tenant_id: UUID


class HealthReport(BaseModel):
    status: str
    active_calls: int
    persistence_ready: bool
    sip_configured: bool


class Dispatcher:
    """One bot per room; persistence must succeed before service or dialing."""

    def __init__(
        self,
        *,
        settings: DispatcherConfig,
        sessions: SessionPersistence,
        sip_client: SipClient,
        launch_bot: LaunchBot,
        resolve_phone: ResolvePhone,
        hangup_room: HangupRoom,
        mint_token: MintToken,
    ) -> None:
        self._settings = settings
        self._sessions = sessions
        self._sip = sip_client
        self._launch = launch_bot
        self._resolve_phone = resolve_phone
        self._hangup_room = hangup_room
        self._mint_token = mint_token
        self._active: dict[str, _Active] = {}

    async def handle_participant_joined(self, event: Any) -> None:
        participant = event.participant
        room = event.room.name
        if participant.kind != ParticipantInfo.SIP or room in self._active:
            return
        resolution = await self._resolve_inbound_number(
            participant.attributes.get("sip.trunkPhoneNumber")
        )
        if resolution is None:
            await self._hangup_room(room)
            return
        context = CallContext(
            call_id=room,
            provider="livekit",
            direction=Direction.INBOUND,
            from_number=participant.attributes.get("sip.phoneNumber"),
            to_number=participant.attributes.get("sip.trunkPhoneNumber"),
            flow_id=resolution.flow_id,
            tenant_id=resolution.tenant_id,
            session_id=uuid5(NAMESPACE_URL, f"or-on-platform:livekit-room:{room}"),
        )
        try:
            created = await self._start(room, context, idempotency_key=f"livekit-room:{room}")
        except Exception:
            await self._hangup_room(room)
            raise
        if not created:
            await self._hangup_room(room)

    async def _resolve_inbound_number(self, dialed: str | None) -> PhoneResolution | None:
        if not dialed:
            logger.warning("Inbound call rejected: missing DID")
            return None
        try:
            normalized = validate_e164(dialed)
        except ValueError:
            logger.warning("Inbound call rejected: malformed DID")
            return None
        resolution = await self._resolve_phone(normalized)
        if resolution is None:
            logger.warning("Inbound call rejected: DID is not registered")
        return resolution

    async def handle_room_finished(self, event: Any) -> None:
        await self._finalize(event.room.name, status=SessionStatus.ENDED)

    async def place_outbound_call(
        self,
        phone_number: str,
        tenant_id: UUID,
        flow_id: UUID,
        *,
        idempotency_key: str,
        explicit_approval: bool,
        flow_version: int | None = None,
        agent_version_id: UUID | None = None,
        caller_gender: Literal["male", "female"] | None = None,
        contact_id: UUID | None = None,
        source_conversation_id: UUID | None = None,
        handoff_id: UUID | None = None,
        overrides: Mapping[str, object] | None = None,
    ) -> DispatchResult:
        normalized = validate_e164(phone_number)
        self._sip.authorize(explicit_approval=explicit_approval)
        session_id = uuid5(
            NAMESPACE_URL,
            f"or-on-platform:livekit-outbound:{tenant_id}:{idempotency_key}",
        )
        room = f"{self._settings.room_prefix}{session_id.hex[:12]}"
        context = CallContext(
            call_id=room,
            direction=Direction.OUTBOUND,
            to_number=normalized,
            flow_id=flow_id,
            flow_version=flow_version,
            agent_version_id=agent_version_id,
            tenant_id=tenant_id,
            session_id=session_id,
            caller_gender=caller_gender,
            contact_id=contact_id,
            source_conversation_id=source_conversation_id,
            handoff_id=handoff_id,
        )
        if active := self._active.get(room):
            binding_fields = (
                "to_number",
                "flow_id",
                "flow_version",
                "agent_version_id",
                "caller_gender",
                "contact_id",
                "source_conversation_id",
                "handoff_id",
            )
            if any(
                getattr(active.context, field) != getattr(context, field)
                for field in binding_fields
            ):
                raise IdempotencyConflict("call parameters differ for the existing key")
            return DispatchResult(session_id=session_id, room=room, created=False)
        created = await self._start(
            room,
            context,
            idempotency_key=idempotency_key,
            overrides=overrides,
        )
        if not created:
            return DispatchResult(session_id=session_id, room=room, created=False)
        try:
            await self._sip.dial(
                room=room,
                phone_number=normalized,
                identity=f"{self._settings.bot_identity}-callee",
                explicit_approval=explicit_approval,
            )
        except Exception:
            await self._finalize(room, status=SessionStatus.FAILED)
            raise
        return DispatchResult(session_id=session_id, room=room, created=True)

    async def start_browser_call(
        self,
        flow_id: UUID,
        tenant_id: UUID,
        overrides: Mapping[str, object] | None = None,
    ) -> BrowserCall:
        room = f"{self._settings.room_prefix}{uuid4().hex[:12]}"
        context = CallContext(
            call_id=room,
            direction=Direction.BROWSER,
            flow_id=flow_id,
            tenant_id=tenant_id,
        )
        created = await self._start(
            room,
            context,
            idempotency_key=f"browser:{context.session_id}",
            overrides=overrides,
        )
        if not created:
            raise PersistenceUnavailable("browser call idempotency collision")
        return BrowserCall(
            room=room,
            session_id=context.session_id,
            token=self._mint_token(room, "web-console"),
        )

    def active_calls(self) -> list[ActiveCall]:
        return [
            ActiveCall(
                room=room,
                session_id=active.context.session_id,
                direction=active.context.direction,
                from_number=active.context.from_number,
                to_number=active.context.to_number,
                flow_id=active.context.flow_id,
                tenant_id=active.context.tenant_id,
            )
            for room, active in self._active.items()
        ]

    async def observer_token(self, room: str) -> str:
        return self._mint_token(room, f"observer-{uuid4().hex[:6]}")

    async def hangup(self, room: str) -> None:
        await self._hangup_room(room)
        await self._finalize(room, status=SessionStatus.ENDED)

    async def _start(
        self,
        room: str,
        context: CallContext,
        *,
        idempotency_key: str,
        overrides: Mapping[str, object] | None = None,
    ) -> bool:
        created = await self._sessions.begin(context, room=room, idempotency_key=idempotency_key)
        if not created:
            return False
        try:
            handle = await self._launch(room, context, overrides)
        except Exception as error:
            logger.error(
                "Voice agent startup refused before dial (error_type=%s)",
                type(error).__name__,
            )
            if not await self._sessions.finalize(context, status=SessionStatus.FAILED):
                raise PersistenceUnavailable("failed to persist failed call startup") from None
            public_reason = getattr(error, "public_reason", None)
            if not isinstance(public_reason, str) or not public_reason:
                public_reason = "voice agent startup preflight failed"
            raise AgentStartupUnavailable(public_reason) from None
        self._active[room] = _Active(context=context, handle=handle)
        observer = getattr(handle, "observe_completion", None)
        if callable(observer):
            observer(
                lambda error: asyncio.create_task(
                    self._handle_agent_completion(room, error),
                    name=f"dispatcher-agent-completion:{context.session_id}",
                )
            )
        return True

    async def _handle_agent_completion(self, room: str, error: BaseException | None) -> None:
        """Close a provider leg when its detached conversational task exits."""

        active = self._active.get(room)
        if active is None:
            return
        if error is not None:
            logger.error(
                "Voice agent stopped unexpectedly (error_type=%s)",
                type(error).__name__,
            )
        try:
            await self._hangup_room(room)
        finally:
            # Do not call handle.cancel() from its own completion callback.
            if not await self._sessions.finalize(
                active.context,
                status=SessionStatus.FAILED if error is not None else SessionStatus.ENDED,
            ):
                logger.error("Voice agent completion could not be persisted")
            self._active.pop(room, None)

    async def _finalize(self, room: str, *, status: SessionStatus) -> None:
        active = self._active.get(room)
        if active is None:
            return
        try:
            await active.handle.cancel()
        finally:
            if not await self._sessions.finalize(active.context, status=status):
                raise PersistenceUnavailable("call finalization was not persisted")
        self._active.pop(room, None)

    async def health(self) -> HealthReport:
        persistence_ready = await self._sessions.ready()
        return HealthReport(
            status="ready" if persistence_ready else "not_ready",
            active_calls=len(self._active),
            persistence_ready=persistence_ready,
            sip_configured=self._sip.configured,
        )
