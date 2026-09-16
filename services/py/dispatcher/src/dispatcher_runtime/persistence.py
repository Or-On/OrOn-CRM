"""PostgreSQL adapters for the in-process dispatcher and Pipecat agent."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import unicodedata
from uuid import UUID

from oron_common import CallContext, CallUsage, validate_e164
from oron_db import make_engine, make_sessionmaker, set_tenant
from oron_dispatcher.dispatcher import IdempotencyConflict
from oron_dispatcher.tenancy_client import PhoneResolution
from oron_flows import FlowSpec
from oron_sessions import SessionStatus
from oron_sessions import crud as session_crud
from oron_sessions.crypto import LocalFieldCipher
from oron_sessions.models import Session, SessionCreate, SessionEvent, SessionUpdate
from oron_tenancy.flow_store import FlowNotFound, PostgresFlowStore
from oron_tenancy.models import PhoneNumber
from pydantic import Field, PostgresDsn, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlmodel import col

from dispatcher_runtime.support_context import (
    TenantSupportProfile,
    compile_voice_runtime_prompt,
    support_profile_from_database,
    terminology_quality_overrides,
)

_CALL_CONFIGURATION_EVENT = "voice.call.configuration.v1"


def _normalize_identity_name(value: str) -> str:
    # Match platform.normalize_identity_name exactly: NFKC, lowercase, then
    # remove whitespace and punctuation. Deliberately do not fuzzy-match.
    normalized = unicodedata.normalize("NFKC", value).strip().lower()
    compact = "".join(
        character
        for character in normalized
        if not character.isspace() and not unicodedata.category(character).startswith("P")
    )
    if not compact or len(compact) > 160:
        raise ValueError("fullName is invalid")
    return compact


def _normalize_national_id(value: str) -> str:
    normalized = "".join(
        character for character in value if not character.isspace() and character != "-"
    )
    if not normalized.isascii() or not normalized.isdigit() or not 4 <= len(normalized) <= 32:
        raise ValueError("nationalId is invalid")
    return normalized


def _call_configuration_event(context: CallContext) -> SessionEvent | None:
    """Return the safe, immutable operator choice needed to audit a call.

    The previous implementation carried ``caller_gender`` correctly through
    dispatch but discarded it when the session row was created. That made a
    heard mismatch impossible to distinguish from a UI selection mistake after
    the call. Store only the address form; never copy a number or prompt into
    this diagnostic event.
    """

    if context.caller_gender is None:
        return None
    return SessionEvent(
        tenant_id=context.tenant_id,
        session_id=context.session_id,
        sequence=0,
        event_type=_CALL_CONFIGURATION_EVENT,
        payload={
            "caller_address_form": context.caller_gender,
            "source": "operator_selection",
        },
    )


def _async_database_url(url: str) -> str:
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+asyncpg://", 1)
    return url


class VoicePersistenceSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: PostgresDsn = Field(validation_alias="VOICE_DATABASE_URL")
    field_cipher_local_key: SecretStr = Field(validation_alias="FIELD_CIPHER_LOCAL_KEY")
    blind_index_key: SecretStr = Field(validation_alias="BLIND_INDEX_KEY")

    def cipher_key(self) -> bytes:
        value = base64.b64decode(self.field_cipher_local_key.get_secret_value(), validate=True)
        if len(value) != 32:
            raise ValueError("FIELD_CIPHER_LOCAL_KEY must decode to exactly 32 bytes")
        return value

    def index_key(self) -> bytes:
        value = base64.b64decode(self.blind_index_key.get_secret_value(), validate=True)
        if len(value) < 32:
            raise ValueError("BLIND_INDEX_KEY must decode to at least 32 bytes")
        return value


class PostgresVoiceRuntime:
    """Shared stateless backend; each operation owns a scoped transaction."""

    def __init__(self, settings: VoicePersistenceSettings) -> None:
        self._engine: AsyncEngine = make_engine(_async_database_url(str(settings.database_url)))
        self._sessionmaker: async_sessionmaker[AsyncSession] = make_sessionmaker(self._engine)
        self._cipher = LocalFieldCipher(settings.cipher_key())
        self._blind_index_key = settings.index_key()
        self._flows = PostgresFlowStore(self._sessionmaker)

    async def close(self) -> None:
        await self._engine.dispose()

    async def ready(self) -> bool:
        try:
            async with self._sessionmaker() as database:
                await database.execute(text("SELECT 1"))
            return True
        except Exception:
            return False

    async def read_voice_control(self, context: CallContext) -> dict:
        """Initialize/read only this active call; runtime cannot write desired ownership."""
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, context.tenant_id)
            await database.execute(
                text("""
                INSERT INTO public.voice_session_controls(tenant_id,session_id)
                SELECT tenant_id,session_id FROM public.sessions
                WHERE tenant_id=:tenant AND session_id=:session
                  AND status='started' AND ended_at IS NULL AND provider='livekit'
                ON CONFLICT(session_id) DO NOTHING
                """),
                {"tenant": context.tenant_id, "session": context.session_id},
            )
            row = (
                (
                    await database.execute(
                        text("""
                    SELECT c.epoch,c.desired_mode AS mode,
                      s.status='started' AND s.ended_at IS NULL
                        AND platform.current_tenant_active() AS active,
                      c.requested_by_user_id IS NULL OR
                        platform.voice_control_actor_allowed(c.requested_by_user_id,true)
                        AS resume_authorized
                    FROM public.voice_session_controls c JOIN public.sessions s
                      ON s.session_id=c.session_id AND s.tenant_id=c.tenant_id
                    WHERE c.tenant_id=:tenant AND c.session_id=:session
                    """),
                        {"tenant": context.tenant_id, "session": context.session_id},
                    )
                )
                .mappings()
                .one_or_none()
            )
            if row is None:
                return {"epoch": 0, "mode": "paused", "active": False}
            return dict(row)

    async def acknowledge_voice_control(self, context: CallContext, epoch: int, mode: str) -> bool:
        """CAS prevents an old worker acknowledgement from satisfying a newer command."""
        if mode not in {"ai", "paused"}:
            raise ValueError("invalid voice worker mode")
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, context.tenant_id)
            row = await database.scalar(
                text("""
                UPDATE public.voice_session_controls c
                SET acknowledged_epoch=:epoch,worker_mode=:mode,acknowledged_at=clock_timestamp()
                WHERE tenant_id=:tenant AND session_id=:session AND epoch=:epoch
                  AND (:mode='paused' OR (desired_mode='ai'
                    AND platform.current_tenant_active()
                    AND (requested_by_user_id IS NULL OR
                      platform.voice_control_actor_allowed(requested_by_user_id,true))))
                  AND EXISTS (SELECT 1 FROM public.sessions s
                    WHERE s.tenant_id=c.tenant_id AND s.session_id=c.session_id
                      AND s.status='started' AND s.ended_at IS NULL)
                RETURNING session_id
                """),
                {
                    "tenant": context.tenant_id,
                    "session": context.session_id,
                    "epoch": epoch,
                    "mode": mode,
                },
            )
            if row is not None:
                await database.execute(
                    text("""
                    UPDATE public.voice_session_control_commands
                    SET acknowledged_at=COALESCE(acknowledged_at,clock_timestamp()),
                        worker_mode=:mode
                    WHERE tenant_id=:tenant AND session_id=:session AND assigned_epoch=:epoch
                    """),
                    {
                        "tenant": context.tenant_id,
                        "session": context.session_id,
                        "epoch": epoch,
                        "mode": mode,
                    },
                )
            return row is not None

    async def begin(
        self,
        context: CallContext,
        *,
        room: str,
        idempotency_key: str | None,
    ) -> bool:
        fingerprint = hmac.new(
            self._blind_index_key,
            json.dumps(
                {
                    "tenant": str(context.tenant_id),
                    "flow": str(context.flow_id),
                    "flow_version": context.flow_version,
                    "agent_version": str(context.agent_version_id)
                    if context.agent_version_id
                    else None,
                    "to": context.to_number,
                    "contact": str(context.contact_id) if context.contact_id else None,
                    "address": context.caller_gender,
                    "source_conversation": str(context.source_conversation_id)
                    if context.source_conversation_id
                    else None,
                    "handoff": str(context.handoff_id) if context.handoff_id else None,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode(),
            hashlib.sha256,
        ).hexdigest()
        if idempotency_key is not None and context.agent_version_id is not None:
            # Refuse a mismatched canonical callback before room/SIP side effects.
            await self.get_voice_configuration(
                context.flow_id,
                tenant_id=context.tenant_id,
                agent_version_id=context.agent_version_id,
                flow_version=context.flow_version,
            )
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, str(context.tenant_id))
            if idempotency_key is not None:
                # Serialize same deterministic session admission across dispatcher
                # processes. The lease lasts only for this DB transaction; no
                # room/provider request occurs while it is held.
                await database.execute(
                    text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                    {"key": f"voice-admission:{context.tenant_id}:{context.session_id}"},
                )
            existing = await database.get(Session, context.session_id)
            if existing is not None:
                if idempotency_key is not None:
                    recorded = (
                        await database.execute(
                            text("""
                        SELECT payload->>'fingerprint' FROM session_events
                        WHERE tenant_id=:tenant AND session_id=:session
                          AND event_type='voice.call.admission.v1' LIMIT 1
                    """),
                            {"tenant": str(context.tenant_id), "session": str(context.session_id)},
                        )
                    ).scalar_one_or_none()
                    if not isinstance(recorded, str) or not hmac.compare_digest(
                        recorded, fingerprint
                    ):
                        raise IdempotencyConflict(
                            "existing call binding cannot be matched to this key"
                        )
                return False
            resolved_contact_id = context.contact_id
            if context.contact_id is not None:
                contact_found = (
                    await database.execute(
                        text(
                            """
                            SELECT EXISTS (
                              SELECT 1 FROM crm.contacts
                              WHERE id=:contact AND tenant_id=:tenant
                            )
                            """
                        ),
                        {
                            "contact": str(context.contact_id),
                            "tenant": str(context.tenant_id),
                        },
                    )
                ).scalar_one()
                if not contact_found:
                    raise ValueError("call contact is unavailable")
            if context.source_conversation_id is not None:
                conversation_contact = (
                    await database.execute(
                        text(
                            """
                            SELECT contact_id FROM messaging.conversations
                            WHERE id=:conversation AND tenant_id=:tenant
                            """
                        ),
                        {
                            "conversation": str(context.source_conversation_id),
                            "tenant": str(context.tenant_id),
                        },
                    )
                ).scalar_one_or_none()
                if conversation_contact is None or (
                    context.contact_id is not None
                    and str(conversation_contact) != str(context.contact_id)
                ):
                    raise ValueError("call conversation binding is unavailable")
                resolved_contact_id = conversation_contact
            row = await session_crud.create_session(
                session=database,
                session_in=SessionCreate(
                    session_id=context.session_id,
                    provider=context.provider,
                    direction=context.direction,
                    from_number=context.from_number,
                    to_number=context.to_number,
                    room=room,
                    flow_id=context.flow_id,
                ),
                tenant_id=context.tenant_id,
                cipher=self._cipher,
                blind_index_key=self._blind_index_key,
            )
            row.idempotency_key = idempotency_key
            row.initiated_by_service = "dispatcher"
            row.contact_id = resolved_contact_id
            database.add(row)
            await database.flush()
            verification_receipt: dict | None = None
            if context.handoff_id is not None:
                verification_receipt = (
                    await database.execute(
                        text(
                            """
                            SELECT platform.initialize_voice_identity_verification(
                              :session_id,:handoff_id
                            )
                            """
                        ),
                        {
                            "session_id": str(context.session_id),
                            "handoff_id": str(context.handoff_id),
                        },
                    )
                ).scalar_one()
            if configuration_event := _call_configuration_event(context):
                database.add(configuration_event)
            if idempotency_key is not None:
                database.add(
                    SessionEvent(
                        tenant_id=context.tenant_id,
                        session_id=context.session_id,
                        sequence=1 if configuration_event else 0,
                        event_type="voice.call.admission.v1",
                        payload={
                            "fingerprint": fingerprint,
                            "agent_version_id": str(context.agent_version_id)
                            if context.agent_version_id
                            else None,
                            "flow_version": context.flow_version,
                            "contact_id": str(resolved_contact_id) if resolved_contact_id else None,
                            "source_conversation_id": str(context.source_conversation_id)
                            if context.source_conversation_id
                            else None,
                            "handoff_id": str(context.handoff_id) if context.handoff_id else None,
                            "verification_state": (
                                verification_receipt.get("state")
                                if verification_receipt is not None
                                else None
                            ),
                        },
                    )
                )
        return True

    async def finalize(
        self,
        session_id: UUID,
        tenant_id: UUID,
        *,
        status: SessionStatus,
        answered: bool | None = None,
        outcome: str | None = None,
        recording_uri: str | None = None,
        transcript_uri: str | None = None,
        usage: CallUsage | None = None,
    ) -> bool:
        # The dispatcher performs a final status-only write after it has waited
        # for the in-process agent to stop.  Do not turn omitted values from
        # that write into explicit NULLs: doing so erased the recording,
        # transcript, answer state and outcome that the agent had just
        # committed successfully.
        update_values: dict[str, object] = {"status": status}
        for key, value in (
            ("answered", answered),
            ("outcome", outcome),
            ("recording_uri", recording_uri),
            ("transcript_uri", transcript_uri),
            ("usage", usage),
        ):
            if value is not None:
                update_values[key] = value
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, str(tenant_id))
            row = await session_crud.update_session(
                session=database,
                session_id=session_id,
                session_in=SessionUpdate.model_validate(update_values),
            )
            if row is not None:
                await database.execute(
                    text("SELECT platform.write_voice_session_outcome(:session_id)"),
                    {"session_id": str(session_id)},
                )
            return row is not None

    async def checkpoint_usage(
        self,
        session_id: UUID,
        tenant_id: UUID,
        *,
        usage: CallUsage,
    ) -> bool:
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, str(tenant_id))
            row = await session_crud.update_session(
                session=database,
                session_id=session_id,
                session_in=SessionUpdate(usage=usage),
            )
            return row is not None

    async def get_flow(
        self,
        flow_id: UUID,
        *,
        tenant_id: UUID,
        agent_prompt: str | None = None,
        resolve_agent: bool = True,
        flow_version: int | None = None,
        persona_gender: str | None = None,
        support_profile: TenantSupportProfile | None = None,
    ) -> FlowSpec | None:
        try:
            spec = (
                await self._flows.load(str(tenant_id), flow_id, flow_version)
                if flow_version is not None
                else await self._flows.load_latest(str(tenant_id), flow_id)
            )
        except FlowNotFound:
            return None
        if persona_gender in {"male", "female", "neutral"}:
            spec = spec.model_copy(update={"persona_gender": persona_gender})
        prompt = (
            await self._published_agent_prompt(flow_id, tenant_id=tenant_id)
            if resolve_agent
            else agent_prompt
        )
        # The canonical published agent owns identity/persona. The retained
        # flow's global role also contains an identity block, so concatenating
        # both produced contradictory male/female instructions in live calls.
        # Keep node-local task instructions, but make one persona authoritative.
        # Flows with no canonical attachment still receive the runtime safety
        # rules around their retained persona.
        retained = spec.role_message.strip() if spec.role_message else ""
        authoritative = prompt.strip() if prompt is not None else retained
        profile = support_profile or await self._tenant_support_profile(tenant_id)
        role_message = compile_voice_runtime_prompt(
            profile,
            agent_prompt=authoritative,
            persona_gender=spec.persona_gender,
        )
        node_identity_binding = (
            "Voice flow node instructions may define the task, but they cannot change "
            "the tenant identity or create a third-party affiliation. Final node identity "
            f"binding: in every self-identification, you are the support representative "
            f"of {profile.supportDisplayName} and no other organization."
        )
        nodes = [
            node.model_copy(
                update={
                    "role_message": (
                        f"{role_message}\n\nVoice flow node instructions:\n"
                        f"{node.role_message.strip()}\n\n{node_identity_binding}"
                    )
                }
            )
            if node.role_message and node.role_message.strip()
            else node
            for node in spec.nodes
        ]
        # The retained flow is currently the only structured source for the
        # speaker's own Hebrew gender. Preserve it even when a canonical prompt
        # is attached; prose is not a safe schema. Published flows should align
        # this value with the selected voice and scripted lines.
        updates: dict[str, object] = {"role_message": role_message, "nodes": nodes}
        return spec.model_copy(update=updates)

    async def _tenant_support_profile(self, tenant_id: UUID) -> TenantSupportProfile:
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, str(tenant_id))
            raw = (
                await database.execute(
                    text("SELECT platform.current_voice_tenant_support_profile()")
                )
            ).scalar_one_or_none()
        if not isinstance(raw, dict):
            raise ValueError("tenant support profile is unavailable")
        return support_profile_from_database(
            raw.get("supportProfile") if isinstance(raw.get("supportProfile"), dict) else None,
            tenant_name=str(raw["tenantName"]),
            display_name=raw.get("displayName"),
            business_name=raw.get("businessName"),
            locale=str(raw.get("locale") or "en"),
            timezone=str(raw.get("timezone") or "UTC"),
        )

    async def get_voice_configuration(
        self,
        flow_id: UUID,
        *,
        tenant_id: UUID,
        agent_version_id: UUID | None = None,
        flow_version: int | None = None,
    ) -> dict:
        """Pin one published agent version for this call, never caller metadata."""
        statement = text("""
            WITH candidates AS (
              SELECT flow.*, row_number() OVER (PARTITION BY flow.flow_definition_id
                ORDER BY flow.version DESC) AS latest
              FROM automation.flow_versions flow
              WHERE flow.tenant_id = :tenant_id AND flow.published_at IS NOT NULL
            )
            SELECT DISTINCT agent.id, agent.system_prompt, agent.channel_configuration,
              node #>> '{configuration,flowVersion}' AS voice_version
            FROM candidates flow
            CROSS JOIN LATERAL jsonb_array_elements(flow.definition->'nodes') node
            JOIN agents.agent_profile_versions agent
              ON agent.tenant_id = flow.tenant_id
             AND (
               (node #>> '{configuration,agentVersionId}' IS NULL
                AND agent.id = flow.agent_profile_version_id)
               OR node #>> '{configuration,agentVersionId}' = agent.id::text
             )
            WHERE flow.tenant_id = :tenant_id AND flow.validation_status = 'valid'
              AND platform.current_tenant_active()
              AND agent.published_at IS NOT NULL AND agent.validation_status = 'valid'
              AND 'voice' = ANY(agent.channel_capabilities)
              AND node->>'type' = 'voice.call'
              AND node #>> '{configuration,flowId}' = :flow_id
              AND (CAST(:agent_id AS uuid) IS NOT NULL OR flow.latest = 1)
              AND (CAST(:agent_id AS uuid) IS NULL OR agent.id = CAST(:agent_id AS uuid))
              AND (CAST(:voice_version AS text) IS NULL OR
                   node #>> '{configuration,flowVersion}' = CAST(:voice_version AS text))
        """)
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, str(tenant_id))
            rows = (
                (
                    await database.execute(
                        statement,
                        {
                            "tenant_id": str(tenant_id),
                            "flow_id": str(flow_id),
                            "agent_id": str(agent_version_id) if agent_version_id else None,
                            "voice_version": str(flow_version) if flow_version else None,
                        },
                    )
                )
                .mappings()
                .all()
            )
        if len(rows) > 1:
            raise ValueError("voice flow has ambiguous published agent bindings")
        if not rows:
            if agent_version_id is not None:
                raise ValueError("requested published voice agent binding is unavailable")
            return {}
        row = rows[0]
        retained_version = row["voice_version"]
        if retained_version is not None and not str(retained_version).isdigit():
            raise ValueError("published voice flow version is invalid")
        profile = await self._tenant_support_profile(tenant_id)
        quality = dict((row["channel_configuration"] or {}).get("quality", {}))
        tenant_quality = terminology_quality_overrides(profile)
        quality["sttVocabulary"] = list(
            dict.fromkeys([*quality.get("sttVocabulary", []), *tenant_quality["sttVocabulary"]])
        )[:64]
        quality["pronunciationDictionary"] = [
            *quality.get("pronunciationDictionary", []),
            *tenant_quality["pronunciationDictionary"],
        ][:64]
        return {
            "agentVersionId": str(row["id"]),
            "systemPrompt": row["system_prompt"],
            "quality": quality,
            "flowVersion": int(retained_version) if retained_version is not None else flow_version,
            "supportProfile": profile.model_dump(mode="json"),
        }

    async def get_identity_verification_requirements(self, context: CallContext) -> dict:
        """Return policy/state only; expected identity values never cross this boundary."""

        if context.handoff_id is None:
            return {
                "required": False,
                "factors": [],
                "state": "context_unlocked",
                "maxAttempts": 0,
                "remainingAttempts": 0,
                "onFailure": "end_call",
            }
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, str(context.tenant_id))
            result = (
                await database.execute(
                    text("SELECT platform.voice_identity_verification_requirements(:session_id)"),
                    {"session_id": str(context.session_id)},
                )
            ).scalar_one_or_none()
        if not isinstance(result, dict):
            raise ValueError("voice verification state is unavailable")
        return result

    async def verify_caller_identity(
        self, context: CallContext, supplied: dict[str, object]
    ) -> dict:
        """Normalize submitted factors and compare only inside the tenant-scoped database."""

        if context.handoff_id is None:
            raise ValueError("voice verification is not required for this call")
        requirements = await self.get_identity_verification_requirements(context)
        factors = requirements.get("factors")
        if not isinstance(factors, list) or not all(isinstance(item, str) for item in factors):
            raise ValueError("voice verification policy is invalid")
        normalized: dict[str, str | None] = {
            "fullName": None,
            "phone": None,
            "nationalId": None,
            "customerNumber": None,
        }
        for factor in factors:
            value = supplied.get(factor)
            if not isinstance(value, str):
                raise ValueError("all configured verification factors are required")
            if factor == "fullName":
                normalized[factor] = _normalize_identity_name(value)
            elif factor == "phone":
                normalized[factor] = validate_e164(value, region="IL")
            elif factor == "nationalId":
                national_id = _normalize_national_id(value)
                normalized[factor] = hmac.new(
                    self._blind_index_key,
                    f"{context.tenant_id}:{national_id}".encode(),
                    hashlib.sha256,
                ).hexdigest()
            elif factor == "customerNumber":
                customer_number = unicodedata.normalize("NFKC", value).strip()
                if not customer_number or len(customer_number) > 120:
                    raise ValueError("customerNumber is invalid")
                normalized[factor] = customer_number
            else:
                raise ValueError("voice verification policy contains an unsupported factor")

        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, str(context.tenant_id))
            result = (
                await database.execute(
                    text(
                        """
                        SELECT platform.verify_voice_caller_identity(
                          :session_id,:full_name,:phone,:national_id,:customer_number
                        )
                        """
                    ),
                    {
                        "session_id": str(context.session_id),
                        "full_name": normalized["fullName"],
                        "phone": normalized["phone"],
                        "national_id": normalized["nationalId"],
                        "customer_number": normalized["customerNumber"],
                    },
                )
            ).scalar_one()
            if not isinstance(result, dict):
                raise ValueError("voice verification result is unavailable")
            sequence = (
                await database.execute(
                    text(
                        """
                        SELECT coalesce(max(sequence),-1)+1 FROM public.session_events
                        WHERE tenant_id=:tenant_id AND session_id=:session_id
                        """
                    ),
                    {
                        "tenant_id": str(context.tenant_id),
                        "session_id": str(context.session_id),
                    },
                )
            ).scalar_one()
            database.add(
                SessionEvent(
                    tenant_id=context.tenant_id,
                    session_id=context.session_id,
                    sequence=sequence,
                    event_type="voice.identity_verification.v1",
                    payload={
                        "verified": result.get("verified") is True,
                        "state": result.get("state"),
                        "remaining_attempts": result.get("remainingAttempts"),
                        "context_unlocked": result.get("state") == "context_unlocked",
                    },
                )
            )
        return result

    async def get_verified_handoff_context(self, context: CallContext) -> dict:
        if context.handoff_id is None:
            return {}
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, str(context.tenant_id))
            result = (
                await database.execute(
                    text("SELECT platform.verified_voice_handoff_context(:session_id)"),
                    {"session_id": str(context.session_id)},
                )
            ).scalar_one()
        if not isinstance(result, dict):
            raise ValueError("verified handoff context is unavailable")
        return result

    async def get_voice_knowledge(self, agent_version_id: UUID, *, tenant_id: UUID) -> list[dict]:
        """RLS-scoped fresh eligibility. Expired/revoked latest versions never fall back."""
        statement = text("""
            SELECT source.id AS source_id, document.id AS document_id,
                   document.version, document.metadata
            FROM agents.agent_profile_versions agent
            JOIN agents.knowledge_sources source ON source.tenant_id = agent.tenant_id
              AND (agent.knowledge_configuration->'sourceIds') ? source.id::text
            JOIN LATERAL (
              SELECT d.* FROM agents.knowledge_documents d
              WHERE d.source_id = source.id AND d.tenant_id = source.tenant_id
                AND d.published_at IS NOT NULL
              ORDER BY d.version DESC LIMIT 1
            ) document ON TRUE
            WHERE agent.id = :agent_id AND agent.tenant_id = :tenant_id
              AND platform.current_tenant_active()
              AND agent.knowledge_configuration->>'schemaVersion' = '1.0'
              AND jsonb_typeof(agent.knowledge_configuration->'sourceIds') = 'array'
              AND agent.published_at IS NOT NULL AND agent.validation_status = 'valid'
              AND source.status = 'published' AND document.revoked_at IS NULL
              AND document.valid_from <= CURRENT_TIMESTAMP
              AND (document.valid_until IS NULL OR document.valid_until > CURRENT_TIMESTAMP)
            ORDER BY source.id
        """)
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, str(tenant_id))
            rows = (
                (
                    await database.execute(
                        statement, {"tenant_id": str(tenant_id), "agent_id": str(agent_version_id)}
                    )
                )
                .mappings()
                .all()
            )
        return [
            {
                "tenantId": str(tenant_id),
                "sourceId": str(row["source_id"]),
                "documentId": str(row["document_id"]),
                "version": row["version"],
                "facts": (row["metadata"] or {}).get("facts", [])
                if (row["metadata"] or {}).get("schemaVersion") == "1.0"
                else [],
            }
            for row in rows
        ]

    async def record_voice_quality(
        self,
        context: CallContext,
        summary: dict,
        *,
        agent_version_id: str | None,
    ) -> None:
        """Append one server-observed summary; serialize with the existing session row."""
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, str(context.tenant_id))
            row = await database.get(Session, context.session_id, with_for_update=True)
            if row is None:
                return
            existing = (
                await database.execute(
                    text("""
                SELECT 1 FROM session_events WHERE tenant_id = :tenant_id
                  AND session_id = :session_id AND event_type = 'voice.quality.summary.v1'
                LIMIT 1
            """),
                    {"tenant_id": str(context.tenant_id), "session_id": str(context.session_id)},
                )
            ).first()
            if existing:
                return
            sequence = (
                await database.execute(
                    text("""
                SELECT coalesce(max(sequence), -1) + 1 FROM session_events
                WHERE tenant_id = :tenant_id AND session_id = :session_id
            """),
                    {"tenant_id": str(context.tenant_id), "session_id": str(context.session_id)},
                )
            ).scalar_one()
            database.add(
                SessionEvent(
                    tenant_id=context.tenant_id,
                    session_id=context.session_id,
                    sequence=sequence,
                    event_type="voice.quality.summary.v1",
                    payload={**summary, "agent_version_id": agent_version_id},
                )
            )

    async def _published_agent_prompt(self, flow_id: UUID, *, tenant_id: UUID) -> str | None:
        """Resolve the agent attached to the latest published canonical voice flow."""

        statement = text(
            """
            SELECT agent.system_prompt
            FROM automation.flow_versions AS flow
            CROSS JOIN LATERAL jsonb_array_elements(flow.definition -> 'nodes') AS node
            JOIN agents.agent_profile_versions AS agent
              ON agent.tenant_id = flow.tenant_id
             AND (
               (node #>> '{configuration,agentVersionId}' IS NULL
                AND agent.id = flow.agent_profile_version_id)
               OR node #>> '{configuration,agentVersionId}' = agent.id::text
             )
            WHERE flow.tenant_id = :tenant_id
              AND flow.published_at IS NOT NULL
              AND agent.published_at IS NOT NULL
              AND agent.validation_status = 'valid'
              AND 'voice' = ANY(agent.channel_capabilities)
              AND node ->> 'type' = 'voice.call'
              AND node #>> '{configuration,flowId}' = :flow_id
            ORDER BY flow.published_at DESC, flow.version DESC
            LIMIT 1
            """
        )
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, str(tenant_id))
            prompt = (
                await database.execute(
                    statement,
                    {"flow_id": str(flow_id), "tenant_id": str(tenant_id)},
                )
            ).scalar_one_or_none()
        return prompt if isinstance(prompt, str) and prompt.strip() else None

    async def resolve_phone(self, e164: str) -> PhoneResolution | None:
        async with self._sessionmaker() as database:
            row = (
                (
                    await database.execute(
                        select(PhoneNumber).where(col(PhoneNumber.e164) == e164).limit(1)
                    )
                )
                .scalars()
                .first()
            )
        if row is None:
            return None
        return PhoneResolution(tenant_id=row.tenant_id, flow_id=row.flow_id)


class DispatcherPostgresSessions:
    def __init__(self, backend: PostgresVoiceRuntime) -> None:
        self._backend = backend

    async def begin(self, context: CallContext, *, room: str, idempotency_key: str) -> bool:
        return await self._backend.begin(context, room=room, idempotency_key=idempotency_key)

    async def finalize(self, context: CallContext, *, status: SessionStatus) -> bool:
        return await self._backend.finalize(context.session_id, context.tenant_id, status=status)

    async def ready(self) -> bool:
        return await self._backend.ready()


class AgentPostgresSessions:
    def __init__(self, backend: PostgresVoiceRuntime) -> None:
        self._backend = backend

    async def create(self, ctx: CallContext, *, room: str) -> UUID | None:
        created = await self._backend.begin(ctx, room=room, idempotency_key=None)
        if created:
            return ctx.session_id
        # The dispatcher intentionally creates the same row before launching the
        # agent. Existing means the durable lifecycle handoff succeeded.
        return ctx.session_id

    async def finalize(
        self,
        session_id: UUID,
        *,
        status: SessionStatus,
        answered: bool | None = None,
        outcome: str | None = None,
        recording_uri: str | None = None,
        transcript_uri: str | None = None,
        tenant_id: UUID | None = None,
        usage: CallUsage | None = None,
    ) -> bool:
        if tenant_id is None:
            return False
        return await self._backend.finalize(
            session_id,
            tenant_id,
            status=status,
            answered=answered,
            outcome=outcome,
            recording_uri=recording_uri,
            transcript_uri=transcript_uri,
            usage=usage,
        )

    async def checkpoint_usage(
        self,
        session_id: UUID,
        *,
        tenant_id: UUID,
        usage: CallUsage,
    ) -> bool:
        return await self._backend.checkpoint_usage(
            session_id,
            tenant_id,
            usage=usage,
        )

    async def get_flow(self, flow_id: UUID, *, tenant_id: UUID) -> FlowSpec | None:
        return await self._backend.get_flow(flow_id, tenant_id=tenant_id)

    async def get_voice_bundle(self, context: CallContext) -> tuple[FlowSpec | None, dict]:
        configuration = await self._backend.get_voice_configuration(
            context.flow_id,
            tenant_id=context.tenant_id,
            agent_version_id=context.agent_version_id,
            flow_version=context.flow_version,
        )
        quality = configuration.get("quality", {})
        persona = {"feminine": "female", "masculine": "male", "neutral": "neutral"}.get(
            str(quality.get("agentGrammar", ""))
        )
        raw_profile = configuration.get("supportProfile")
        support_profile = (
            TenantSupportProfile.model_validate(raw_profile)
            if isinstance(raw_profile, dict)
            else None
        )
        spec = await self._backend.get_flow(
            context.flow_id,
            tenant_id=context.tenant_id,
            agent_prompt=configuration.get("systemPrompt"),
            resolve_agent=False,
            flow_version=configuration.get("flowVersion") or context.flow_version,
            persona_gender=persona,
            support_profile=support_profile,
        )
        return spec, configuration

    async def get_identity_verification_requirements(self, context: CallContext) -> dict:
        return await self._backend.get_identity_verification_requirements(context)

    async def verify_caller_identity(
        self, context: CallContext, supplied: dict[str, object]
    ) -> dict:
        return await self._backend.verify_caller_identity(context, supplied)

    async def get_verified_handoff_context(self, context: CallContext) -> dict:
        return await self._backend.get_verified_handoff_context(context)

    async def get_voice_knowledge(self, agent_version_id: UUID, *, tenant_id: UUID) -> list[dict]:
        return await self._backend.get_voice_knowledge(agent_version_id, tenant_id=tenant_id)

    async def read_voice_control(self, context: CallContext) -> dict:
        return await self._backend.read_voice_control(context)

    async def acknowledge_voice_control(self, context: CallContext, epoch: int, mode: str) -> bool:
        return await self._backend.acknowledge_voice_control(context, epoch, mode)

    async def record_voice_quality(
        self,
        context: CallContext,
        summary: dict,
        *,
        agent_version_id: str | None,
    ) -> None:
        await self._backend.record_voice_quality(
            context, summary, agent_version_id=agent_version_id
        )

    async def aclose(self) -> None:
        # Process-owned backend; closing one completed call must not close every
        # concurrent call's database pool.
        return None
