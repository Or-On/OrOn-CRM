from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import UUID

from loguru import logger
from oron_common import CallContext, CallUsage, Direction, PriceBook, carrier_for
from oron_flows import FlowVoice
from oron_flows.node import ActionType
from oron_hebrew import build_g2p, make_hebrew_niqqud_transformer
from oron_sessions import SessionsClient, SessionStatus
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.flows import FlowManager
from pipecat.frames.frames import ErrorFrame, LLMMessagesAppendFrame
from pipecat.observers.base_observer import BaseObserver
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext, LLMContextMessage
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frameworks.rtvi import RTVIObserver, RTVIObserverParams, RTVIProcessor

# Pinned (Pipecat 1.5.0): LiveKitTransport lives in .transport, NOT the package top level.
from pipecat.transports.livekit.transport import LiveKitTransport
from pipecat.turns.user_start.base_user_turn_start_strategy import (
    BaseUserTurnStartStrategy,
)
from pipecat.turns.user_stop.external_user_turn_stop_strategy import (
    ExternalUserTurnStopStrategy,
)
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import (
    SpeechTimeoutUserTurnStopStrategy,
)
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter
from pipecat.workers.runner import WorkerRunner
from renikud_onnx import G2P

if TYPE_CHECKING:
    from oron_hebrew.gender_audio_ecapa import GenderClassifierProcessor

from oron_agent.answered import wait_until_answered
from oron_agent.artifacts import SessionDir
from oron_agent.audio import TurnEnd, build_audio_in_filter, build_turn_start_strategy
from oron_agent.audio_buffer import AlignedAudioBufferProcessor
from oron_agent.bot_speaking import BotSpeakingObserver
from oron_agent.caller_gender import (
    CallerGender,
    CallerGenderContextProcessor,
    CallerGenderState,
    apply_caller_gender_to_flow,
    caller_gender_instruction,
)
from oron_agent.config import AgentOverrides, Settings, load_settings, settings_for_call
from oron_agent.context_hygiene import OpeningTurnContext
from oron_agent.conversation_language import (
    CallerLanguageContextProcessor,
    ConversationLanguageState,
    ResponseLanguageTTSProcessor,
)
from oron_agent.cost import UsageObserver
from oron_agent.flows import initial_node_from_spec
from oron_agent.flows.resolve import StoredFlowUnavailable, resolve_flow_spec
from oron_agent.grounding import VoiceEvidenceContext, VoiceEvidenceGate
from oron_agent.hangup import hangup_room
from oron_agent.hold_opener import HoldOpener
from oron_agent.identity_verification import (
    IdentityVerificationRequirements,
    identity_verification_entry,
    unlocked_handoff_entry,
)
from oron_agent.idle import UserIdlePoker
from oron_agent.knowledge_turn import TurnKnowledgeReader
from oron_agent.language import language_profile
from oron_agent.lead_capture import AcceptedTurns, VoiceLeadTools, parse_lead_field_schema
from oron_agent.llm import LlmProvider, build_llm, warm_prompt_cache
from oron_agent.memory_cadence import VoiceMemoryCapture
from oron_agent.ownership_stt import OwnershipSonioxSTTService
from oron_agent.pipeline import build_agent_processors
from oron_agent.quality_observer import VoiceQualityObserver, component_latency_observer
from oron_agent.quality_persistence import persist_quality_summary, stage_quality_snapshot
from oron_agent.readiness import bind_pipeline_readiness
from oron_agent.recognition import RecognitionAcceptanceProcessor
from oron_agent.runtime_sessions import RuntimeSessions
from oron_agent.scope_guard import (
    ServiceScopeOutputGate,
    ServiceScopeRouter,
    ServiceScopeTextFilter,
    background_event_recorder,
)
from oron_agent.service_intake import build_voice_service_intake, service_intake_instruction
from oron_agent.session_recorder import SessionRecorder, finish_after_cancellation
from oron_agent.spoken_safety import BusinessClaimGuardFilter
from oron_agent.storage import build_artifact_store, save_audio_file
from oron_agent.support_ticket import support_ticket_function_factory
from oron_agent.text_diagnostics import ModelTextDiagnosticsObserver, VoiceTextDiagnostics
from oron_agent.tokens import mint_room_token
from oron_agent.tool_call_guard import HallucinatedToolCallGuard
from oron_agent.tracing import conversation_span_attributes, setup_process_tracing
from oron_agent.transcript import TranscriptHandler, TranscriptMessage
from oron_agent.transfer import make_emergency_transfer, make_transfer_action
from oron_agent.transport import build_transport_params
from oron_agent.tts import SonioxUnpointedContextTTSService, TtsProvider, build_tts
from oron_agent.tts_trim import TrimLeadingSilence
from oron_agent.turn_planner import HebrewTurnPlanner
from oron_agent.turn_taking import TurnTaking, TurnTakingObserver
from oron_agent.voice_control import VoiceControlGate, VoiceController, VoiceControlSnapshot
from oron_agent.voice_failure import VoiceFailurePolicy
from oron_agent.voice_quality import (
    RecognitionContextProfile,
    VoiceQualityConfig,
    build_soniox_context,
    make_speech_transformer,
)


class RealVoiceProvidersDenied(RuntimeError):
    """Provider-backed voice execution was not explicitly enabled."""


def require_real_voice_providers(settings: Settings) -> None:
    if not settings.enable_real_voice_providers:
        raise RealVoiceProvidersDenied("real voice providers are disabled")


def build_user_aggregator_params(st: Settings) -> LLMUserAggregatorParams:
    """Turn-taking: Silero VAD detects speech; a turn starts on a transcript
    and stops after a short silence so the utterance is flushed to the LLM.

    Under `TURN_END=soniox`, the server's semantic endpoint signal owns only the
    stop decision. We intentionally retain the selected local start strategy;
    accepting Soniox's bundled recommendation would replace the transcript word
    gate with an external start signal and reintroduce wordless interruptions.
    """
    vad = SileroVADAnalyzer(
        params=VADParams(
            stop_secs=st.vad_stop_secs,
            confidence=st.vad_confidence,
            min_volume=st.vad_min_volume,
        )
    )
    start: list[BaseUserTurnStartStrategy] = [
        build_turn_start_strategy(
            st.turn_start,
            min_words=st.interrupt_min_words,
            krisp_api_key=st.krisp_api_key.get_secret_value(),
            krisp_ip_model_path=st.krisp_ip_model_path,
        )
    ]
    if st.turn_end is TurnEnd.SONIOX:
        return LLMUserAggregatorParams(
            vad_analyzer=vad,
            user_turn_strategies=UserTurnStrategies(
                start=start,
                stop=[ExternalUserTurnStopStrategy(timeout=0.15)],
            ),
        )
    return LLMUserAggregatorParams(
        vad_analyzer=vad,
        user_turn_strategies=UserTurnStrategies(
            start=start,
            stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=st.user_speech_timeout)],
        ),
    )


def _flow_voice_for(voice: FlowVoice, provider: TtsProvider) -> str | None:
    """The flow's voice name, only while the provider it named is still in play.

    A flow that says {gemini, "Leda"} and is A/B'd from the console with
    `tts_provider=soniox` would otherwise send a Gemini voice to Soniox.
    """
    if voice.tts_provider is not None and voice.tts_provider is not provider:
        return None
    return voice.tts_voice


async def build_voice_lead_tools(
    sessions: Any, ctx: CallContext, configuration: dict, turns: AcceptedTurns
) -> VoiceLeadTools | None:
    """The pinned agent version's lead actions for this call, or None.

    An agent published with lead capabilities that this runtime cannot honour
    stops the call rather than running as a different agent without them.
    Only the absence of a known contact — an unidentified inbound caller —
    leaves the actions off, because a lead belongs to a person.
    """

    capabilities = [
        capability
        for capability in configuration.get("capabilities") or []
        if isinstance(capability, str) and capability.startswith("lead.")
    ]
    if not capabilities:
        return None
    schema_id = configuration.get("leadFieldSchemaId")
    agent_version_id = configuration.get("agentVersionId")
    schema_reader = getattr(sessions, "get_lead_field_schema", None)
    store_factory = getattr(sessions, "lead_store", None)
    if (
        not isinstance(schema_id, str)
        or not isinstance(agent_version_id, str)
        or schema_reader is None
        or store_factory is None
    ):
        raise StoredFlowUnavailable("published lead capture configuration cannot be executed")
    if ctx.contact_id is None:
        logger.info(
            "lead actions unavailable: call has no known contact (session={})", ctx.session_id
        )
        return None
    pinned = await schema_reader(schema_id, tenant_id=ctx.tenant_id)
    if pinned is None:
        raise StoredFlowUnavailable("pinned lead field schema is unavailable")
    role_title = configuration.get("roleTitle")
    return VoiceLeadTools(
        store=store_factory(
            ctx,
            agent_version_id=agent_version_id,
            schema=pinned,
            business_objective=role_title if isinstance(role_title, str) else None,
        ),
        schema=parse_lead_field_schema(pinned["definition"]),
        capabilities=capabilities,
        interaction_key=str(ctx.session_id),
        turns=turns,
    )


def pipeline_params() -> PipelineParams:
    """BOTH metrics flags, and that is the whole point of this function existing.

    `enable_metrics` covers TTFB and processing time; token and character counts
    sit behind `enable_usage_metrics`, which defaults to False — frame_processor
    gates `start_llm_usage_metrics` on it. With only the first flag a call
    reports latency and audio seconds correctly and every LLM/TTS figure as
    zero, which is how it ran in production until 2026-07-27.
    """
    return PipelineParams(enable_metrics=True, enable_usage_metrics=True)


async def run_bot(
    transport: LiveKitTransport,
    ctx: CallContext,
    st: Settings | None = None,
    *,
    room: str,
    g2p: G2P | None,
    overrides: AgentOverrides | None = None,
    sessions: RuntimeSessions | None = None,
    ready: asyncio.Event | None = None,
    drain_requested: asyncio.Event | None = None,
    on_drain: Callable[[], Awaitable[None]] | None = None,
    on_failure: Callable[[], Awaitable[None]] | None = None,
    on_recovery: Callable[[], Awaitable[None]] | None = None,
):
    # `room`, never `st.livekit_room`: the dispatcher runs every call in-process
    # against one shared Settings, so that field holds a deployment-wide default
    # and not the room this call is in.
    # Given, not reloaded: a per-call copy carries the console's tuned knobs, and
    # reloading here would quietly discard them.
    st = st or load_settings()
    logger.info(f"Starting oron-agent (session={ctx.session_id}, room={room})")

    uses_http_sessions = sessions is None
    sessions = sessions or SessionsClient(
        st.sessions_api_url,
        api_key=st.sessions_api_key.get_secret_value() if st.sessions_api_key else None,
    )
    configuration: dict = {}
    bundle_reader = getattr(sessions, "get_voice_bundle", None)
    if bundle_reader is not None:
        spec, configuration = await bundle_reader(ctx)
        if spec is None:
            raise StoredFlowUnavailable("published tenant voice flow is unavailable")
    else:
        spec = await resolve_flow_spec(sessions, ctx)
    quality = configuration.get("quality", {})
    if not isinstance(quality, dict):
        quality = {}
    knowledge_reader = getattr(sessions, "get_voice_knowledge", None)
    agent_version_id = configuration.get("agentVersionId")
    verification_requirements: IdentityVerificationRequirements | None = None
    verify_identity = getattr(sessions, "verify_caller_identity", None)
    load_handoff_context = getattr(sessions, "get_verified_handoff_context", None)
    requirements_reader = getattr(sessions, "get_identity_verification_requirements", None)
    if ctx.handoff_id is not None or requirements_reader is not None:
        if requirements_reader is None or verify_identity is None or load_handoff_context is None:
            raise StoredFlowUnavailable("secure handoff verification runtime is unavailable")
        verification_requirements = IdentityVerificationRequirements.model_validate(
            await requirements_reader(ctx)
        )
        if (
            ctx.handoff_id is None
            and not verification_requirements.factors
            and not verification_requirements.required
        ):
            verification_requirements = None
    verification_runtime_state = {
        "state": (
            verification_requirements.state
            if verification_requirements is not None
            else "context_unlocked"
        )
    }
    # Final caller turns only; provisional recognition never gets an identifier.
    accepted_turns = AcceptedTurns()
    memory_append = getattr(sessions, "append_voice_memory_turn", None)
    memory_finish = getattr(sessions, "finish_voice_memory", None)
    voice_memory = None
    if memory_append is not None and memory_finish is not None:

        async def append_memory(ordinal: int, caller_text: str) -> None:
            await memory_append(ctx, ordinal, caller_text)

        async def finish_memory() -> None:
            await memory_finish(ctx)

        voice_memory = VoiceMemoryCapture(append_memory, finish_memory)
    ticket_receipt_state: dict[str, Any] = {}
    lead_tools = await build_voice_lead_tools(sessions, ctx, configuration, accepted_turns)
    service_intake = await build_voice_service_intake(
        sessions,
        ctx,
        configuration,
        accepted_turns,
        ticket_receipt_state,
        context_locked=verification_runtime_state["state"] != "context_unlocked",
        # The on-call number reaches only this function, from server
        # configuration; the model sees neither the number nor the call.
        emergency_transfer=make_emergency_transfer(
            room=room,
            url=st.livekit_url,
            api_key=st.livekit_api_key.get_secret_value(),
            api_secret=st.livekit_api_secret.get_secret_value(),
            sip_refer_supported=ctx.sip_refer_supported,
        ),
    )
    if service_intake is not None:
        intake_prompt = service_intake_instruction(service_intake.initial)
        spec = spec.model_copy(
            update={
                "role_message": f"{spec.role_message or ''}\n\n{intake_prompt}",
                "nodes": [
                    node.model_copy(
                        update={"role_message": f"{node.role_message}\n\n{intake_prompt}"}
                    )
                    if node.role_message
                    else node
                    for node in spec.nodes
                ],
            }
        )
    ticket_enabled = (
        "ticket.open" in (configuration.get("capabilities") or [])
        and service_intake is None
        and callable(getattr(sessions, "open_support_ticket", None))
    )
    save_claim_receipted = (
        accepted_turns.receipt_for_current_turn if lead_tools or service_intake else None
    )
    business_actions = (
        (tuple(descriptor.name for descriptor in lead_tools.descriptors) if lead_tools else ())
        + (service_intake.tool_names if service_intake else ())
        + (("open_support_ticket",) if ticket_enabled else ())
    )
    session_dir = SessionDir(ctx.session_id, root=str(Path(st.artifacts_local_root) / ".staging"))
    text_diagnostics = (
        VoiceTextDiagnostics(
            session_dir.text_diagnostics,
            session_id=ctx.session_id,
            tenant_id=ctx.tenant_id,
            handoff_id=ctx.handoff_id,
            verification_state=(
                verification_requirements.state
                if verification_requirements is not None
                else "context_unlocked"
            ),
        )
        if st.text_diagnostics_enabled
        else None
    )

    async def load_knowledge() -> list[dict]:
        if knowledge_reader is None or not agent_version_id:
            return []
        return await knowledge_reader(UUID(agent_version_id), tenant_id=ctx.tenant_id)

    revision_reader = getattr(sessions, "get_voice_knowledge_revisions", None)

    async def load_knowledge_revisions() -> list[str]:
        if revision_reader is None or not agent_version_id:
            return []
        return await revision_reader(UUID(agent_version_id), tenant_id=ctx.tenant_id)

    turn_knowledge = TurnKnowledgeReader(
        load_knowledge, load_knowledge_revisions if revision_reader is not None else None
    )

    # Only the versioned database snapshot sets these values, never caller data.
    persona = {"feminine": "female", "masculine": "male", "neutral": "neutral"}.get(
        str(quality.get("agentGrammar", ""))
    )
    updates: dict[str, object] = {}
    if persona:
        updates["persona_gender"] = persona
    if quality.get("language") in {"he", "en"}:
        updates["language"] = quality["language"]
    spec = spec.model_copy(update=updates)
    quality_config = VoiceQualityConfig.model_validate(
        {
            "language": "he" if spec.language.startswith("he") else "en",
            "agentGrammar": {"female": "feminine", "male": "masculine", "neutral": "neutral"}[
                spec.persona_gender
            ],
            **quality,
        }
    )
    # Only now is the flow known, so only now can its voice be applied — under
    # the console's per-call knobs, over the deployment's defaults. The sessions
    # client above is built from credentials no override may touch.
    st = settings_for_call(st, spec.voice, overrides)
    profile = language_profile(spec.language)
    conversation_language = ConversationLanguageState(spec.language)
    # The only name the approved scope responses may use: the reviewed tenant
    # profile resolved by the server, never caller or model text.
    support_profile = configuration.get("supportProfile")
    business_name = (
        support_profile.get("supportDisplayName") or support_profile.get("displayName")
        if isinstance(support_profile, dict)
        else None
    )
    policy_writer = getattr(sessions, "record_policy_event", None)

    async def record_policy_event(stage: str, category: str, action: str) -> None:
        if policy_writer is not None:
            await policy_writer(ctx, stage=stage, category=category, action=action)

    scope_event = background_event_recorder(
        record_policy_event if policy_writer is not None else None
    )
    if service_intake is not None:
        service_intake.bind_language(lambda: conversation_language.current)

    stt = OwnershipSonioxSTTService(
        api_key=st.soniox_api_key.get_secret_value(),
        # True is pipecat mode: Soniox's own endpoint detection is DISABLED and
        # our VAD + speech timeout decide the turn. False hands the decision to
        # the model.
        vad_force_turn_endpoint=st.turn_end is TurnEnd.VAD,
        settings=OwnershipSonioxSTTService.Settings(
            model=st.soniox_stt_model,
            language_hints=profile.stt_hints,
            # This platform is bilingual. Hints keep the authored language
            # preferred while Soniox can still identify a language switch.
            language_hints_strict=False,
            # Soniox v5 labels finalized tokens and Pipecat resolves their
            # dominant language onto the accepted TranscriptionFrame. This is
            # the sole live language signal; conversational meaning stays with
            # the LLM.
            enable_language_identification=True,
            # Orientation plus literal spellings, from the SAME immutable
            # published version the prompt is compiled from. Nothing the caller
            # says and no CRM record reaches the recognizer.
            context=build_soniox_context(
                quality_config, RecognitionContextProfile.from_configuration(configuration)
            ),
            endpoint_latency_adjustment_level=(
                st.soniox_endpoint_latency_adjustment_level
                if st.turn_end is TurnEnd.SONIOX
                else None
            ),
            endpoint_sensitivity=(
                st.soniox_endpoint_sensitivity if st.turn_end is TurnEnd.SONIOX else None
            ),
            max_endpoint_delay_ms=(
                st.soniox_max_endpoint_delay_ms if st.turn_end is TurnEnd.SONIOX else None
            ),
        ),
    )
    token_budget = quality.get("budgets", {}).get("maxResponseTokens", st.llm_max_tokens)
    if not isinstance(token_budget, int) or isinstance(token_budget, bool):
        token_budget = st.llm_max_tokens
    llm = build_llm(
        st.llm_provider,
        project_id=st.google_cloud_project,
        location=st.vertex_location,
        credentials_path=st.google_application_credentials,
        vertex_model=st.vertex_llm_model,
        thinking_budget=st.vertex_thinking_budget,
        api_key=st.llm_api_key.get_secret_value(),
        base_url=st.llm_base_url,
        model=st.llm_model,
        reasoning_effort=st.llm_reasoning_effort,
        temperature=st.llm_temperature,
        max_tokens=min(st.llm_max_tokens, max(64, min(2048, token_budget))),
        request_timeout_secs=st.llm_request_timeout_secs,
    )

    # Hebrew wiring. The G2P sits on the OUTPUT path only: its job is to point
    # the LLM's Hebrew so TTS reads it correctly. Nothing diacritizes caller
    # speech — there is no reason to run G2P before the LLM.
    # g2p is injected, not built here: loading the model costs ~1s, and inside
    # run_bot that lands on a caller who is already connected and hearing silence.
    if st.tts_niqqud and g2p is None:
        logger.warning(
            "TTS_NIQQUD is enabled but no verified Renikud model is loaded; "
            "Hebrew will use vendor pronunciation plus the authored lexicon "
            f"(session={ctx.session_id})"
        )

    # Caller gender is call-local. Acoustic classification, when explicitly
    # enabled, is only provisional; an explicit caller correction is
    # authoritative and cannot be overwritten by a later audio inference.
    default_address = {
        "masculine": "male",
        "feminine": "female",
        "neutral": "neutral",
        "unknown": "unknown",
    }.get(str(quality.get("callerAddressDefault", "")))
    address = ctx.caller_gender or default_address
    configured_caller_gender = CallerGender(address) if address else None
    caller_gender = CallerGenderState(configured_caller_gender)
    if configured_caller_gender is not None:
        # FlowManager applies role_message after LLMContext construction. Put
        # the selected address form into that primary provider instruction so
        # the female agent persona cannot be confused with the male caller.
        spec = apply_caller_gender_to_flow(spec, configured_caller_gender)
        logger.info(
            "Configured caller address form: {} (session={})",
            configured_caller_gender.value,
            ctx.session_id,
        )

    async def _on_gender_classified(gender: str, confidence: float) -> None:
        detected = caller_gender.observe_acoustic(gender)
        if detected is None:
            logger.info(f"Caller gender inconclusive ({confidence:.2f}) (session={ctx.session_id})")
            return
        logger.info(
            f"Caller gender: {detected.value} ({confidence:.2f}) (session={ctx.session_id})"
        )
        # run_llm=False: this is context for the NEXT turn, not a reason to speak.
        classifier = gender_classifier
        if classifier is None:
            return
        await classifier.push_frame(
            LLMMessagesAppendFrame(
                messages=[
                    {
                        "role": "system",
                        "content": (
                            caller_gender_instruction(
                                CallerGender(detected),
                                explicit=False,
                                persona_gender=spec.persona_gender,
                            )
                        ),
                    }
                ],
                run_llm=False,
            )
        )

    # The observer is constructed first so the classifier can close over its
    # state: inbound audio while the bot speaks is echo, not the caller.
    bot_speaking = BotSpeakingObserver()
    gender_classifier: GenderClassifierProcessor | None = None
    if st.gender_detection_enabled:
        try:
            from oron_hebrew.gender_audio_ecapa import GenderClassifierProcessor
        except ImportError as error:
            raise RuntimeError(
                "GENDER_DETECTION_ENABLED requires the optional oron-agent[gender] runtime"
            ) from error
        gender_classifier = GenderClassifierProcessor(
            required_seconds=st.gender_required_seconds,
            confidence_threshold=st.gender_confidence_threshold,
            max_seconds=st.gender_max_seconds,
            retry_interval_seconds=st.gender_retry_interval_seconds,
            confirmation_attempts=st.gender_confirmation_attempts,
            on_gender_classified=_on_gender_classified,
            is_bot_speaking=lambda: bot_speaking.is_speaking,
            model_path=st.ecapa_model_path,
            model_sha256=st.ecapa_model_sha256,
        )
    elif configured_caller_gender is None:
        logger.info("Caller gender classification disabled; using neutral address")

    tts = build_tts(
        st.tts_provider,
        language=profile.tts_language,
        # Per-call first, then the flow's own choice, then the provider's
        # default — the same order the settings merge above follows. The flow's
        # name is dropped when an override moved the provider away from the one
        # it named: voice names are per-vendor namespaces, so "Leda" reaching
        # Soniox is a 400 on the first utterance of a live call.
        voice=(
            ctx.tts_voice
            or quality_config.voiceId
            or _flow_voice_for(spec.voice, st.tts_provider)
            or st.tts_voice_default
        ),
        # Markdown first: the model emits **bold** and "* " bullets despite being
        # told not to, and TTS voices the asterisks. Heard live 2026-07-26.
        # HebrewNormalizeFilter then does the spoken-form rules and drops emoji.
        text_filters=[
            MarkdownTextFilter(),
            BusinessClaimGuardFilter(
                lambda: conversation_language.current,
                lambda: (
                    verification_runtime_state["state"]
                    in {"identity_required", "collecting_identity", "verifying_identity"}
                ),
                lambda: bool(ticket_receipt_state.get("ticketId")),
                save_claim_receipted,
            ),
            # Last filter: every utterance, including ones that never passed
            # the model, is checked against the scope policy before synthesis.
            ServiceScopeTextFilter(
                language=lambda: conversation_language.current,
                business_name=business_name if isinstance(business_name, str) else None,
                on_event=scope_event,
            ),
        ],
        text_aggregation_mode=st.tts_text_aggregation,
        first_clause=st.tts_first_clause,
        speed=quality_config.speakingPace if "speakingPace" in quality else st.tts_speed,
        reduce_silence=st.tts_reduce_silence,
        soniox_api_key=st.soniox_api_key.get_secret_value(),
        soniox_model=st.soniox_tts_model,
        gemini_model=st.gemini_tts_model,
        google_credentials_path=st.google_application_credentials,
    )
    tts.add_text_transformer(
        make_speech_transformer(
            quality_config,
            lambda: caller_gender.tts_value,
            get_language=lambda: conversation_language.current,
        )
    )
    tts.add_text_transformer(
        make_hebrew_niqqud_transformer(
            g2p if st.tts_niqqud else None,
            lambda: caller_gender.tts_value,
            persona_gender=spec.persona_gender,
            # Pronunciation is tenant-authored and published with the flow. Do
            # not bake a single company's wording into the shared runtime.
            pronunciations=spec.pronunciations,
        )
    )
    if text_diagnostics is not None:

        async def capture_tts_input(text: str, _aggregation_type: object) -> str:
            text_diagnostics.record_tts(text)
            return text

        # Last transformer: this is the exact normalized text handed to the
        # provider, after terminology and Hebrew pronunciation processing.
        tts.add_text_transformer(capture_tts_input)

    initial_messages: list[LLMContextMessage] | None = (
        [
            {
                "role": "system",
                "content": caller_gender_instruction(
                    configured_caller_gender,
                    explicit=False,
                    configured=True,
                    persona_gender=spec.persona_gender,
                ),
            }
        ]
        if configured_caller_gender is not None
        else None
    )
    context = LLMContext(messages=initial_messages)
    context_aggregator = LLMContextAggregatorPair(
        context,
        user_params=build_user_aggregator_params(st),
    )
    caller_gender_context = CallerGenderContextProcessor(
        caller_gender,
        session_id=str(ctx.session_id),
        persona_gender=spec.persona_gender,
    )
    caller_language_context = CallerLanguageContextProcessor(conversation_language)
    response_language = ResponseLanguageTTSProcessor(conversation_language)
    tool_call_guard = HallucinatedToolCallGuard()
    turn_planner = HebrewTurnPlanner()
    # Artifacts are staged locally during the call and uploaded at teardown.
    transcript_handler = TranscriptHandler(output_file=session_dir.transcript)
    # Stereo: caller on the left channel, agent on the right. A mixed mono file
    # cannot be scored for turn-taking, barge-in, or per-speaker audio quality,
    # and the caller-only channel is what gender/turn evals need as input.
    audiobuffer = AlignedAudioBufferProcessor(num_channels=2)
    # Transcripts and TTFB onto the transport's data channel, which is how the
    # dev console watches a call it is not otherwise part of.
    rtvi = RTVIProcessor()

    user_idle = UserIdlePoker(
        prompts=profile.idle_prompts,
        timeout_secs=st.user_idle_secs,
        prompts_for_current_language=lambda: (
            language_profile(conversation_language.current).idle_prompts
            if conversation_language.current in {"he", "en"}
            else profile.idle_prompts
        ),
    )
    control_reader = getattr(sessions, "read_voice_control", None)
    control_writer = getattr(sessions, "acknowledge_voice_control", None)
    voice_control = None
    if control_reader is not None and control_writer is not None:

        async def read_control() -> VoiceControlSnapshot:
            return VoiceControlSnapshot(**await control_reader(ctx))

        async def acknowledge_control(epoch, mode) -> bool:
            return await control_writer(ctx, epoch, mode)

        voice_control = VoiceController(read_control, acknowledge_control)
        stt.enable_ownership()
        voice_control.track_producer(llm)
        voice_control.track_producer(tts, synthesis=True)
    evidence_gate = VoiceEvidenceGate(
        tenant_id=str(ctx.tenant_id),
        language=lambda: conversation_language.current,
        load_records=turn_knowledge.for_speech,
        save_claim_receipted=save_claim_receipted,
        allow_ticket_claim=lambda: bool(ticket_receipt_state.get("ticketId")),
    )
    processors = build_agent_processors(
        transport.input(),
        stt,
        context_aggregator.user(),
        llm,
        tts,
        transport.output(),
        context_aggregator.assistant(),
        gender_classifier=gender_classifier,
        caller_gender_context=caller_gender_context,
        caller_language_context=caller_language_context,
        turn_planner=turn_planner,
        opening_context=OpeningTurnContext(),
        evidence_context=VoiceEvidenceContext(
            tenant_id=str(ctx.tenant_id),
            language=lambda: conversation_language.current,
            load_records=turn_knowledge.begin_turn,
            on_caller_text=evidence_gate.observe_caller_text,
            business_actions=business_actions,
        ),
        evidence_gate=evidence_gate,
        response_language=response_language,
        recognition=RecognitionAcceptanceProcessor(),
        audio_buffer=audiobuffer,
        tts_trim=TrimLeadingSilence(),
        bot_speaking=bot_speaking,
        hold_opener=HoldOpener(
            lambda: bot_speaking.opener_done, max_hold_secs=st.opener_hold_max_secs
        ),
        user_idle=user_idle,
        rtvi=rtvi,
        ownership_input=VoiceControlGate(voice_control) if voice_control else None,
        ownership_recognition=VoiceControlGate(voice_control, recognition=True)
        if voice_control
        else None,
        ownership_model=VoiceControlGate(voice_control) if voice_control else None,
        ownership_generated=VoiceControlGate(voice_control, generated=True)
        if voice_control
        else None,
        tool_call_guard=tool_call_guard,
        ownership_speech=VoiceControlGate(voice_control) if voice_control else None,
        ownership_output=VoiceControlGate(voice_control, audio=True) if voice_control else None,
        scope_router=ServiceScopeRouter(
            language=lambda: conversation_language.current,
            business_name=business_name if isinstance(business_name, str) else None,
            on_event=scope_event,
        ),
        scope_output=ServiceScopeOutputGate(
            language=lambda: conversation_language.current,
            business_name=business_name if isinstance(business_name, str) else None,
            on_event=scope_event,
        ),
    )
    if voice_control is not None:

        async def resume_usable_capture(generation: int) -> None:
            if not all(producer.is_usable for producer in (stt, llm, tts)):
                raise RuntimeError("required voice processor is unavailable")
            await stt.resume_capture(generation)

        voice_control.attach(
            processors[1:],
            on_mode=user_idle.set_ai_paused,
            pause_capture=stt.pause_capture,
            reset_utterance=context_aggregator.user().reset,
            resume_capture=resume_usable_capture,
        )
    # Per-call dispatch (M4): the bot joins when a caller is present and should die
    # when the call ends. agent_idle_timeout_secs is the orphan safety net.
    usage = CallUsage(carrier=carrier_for(ctx))
    turn_taking = TurnTaking()
    call_clock: dict[str, float] = {}
    # An outbound attempt is unanswered until active is observed, including a
    # disconnect during the pickup wait. Inbound keeps its existing unknown state.
    pickup: dict[str, bool] = {"answered": False} if ctx.direction is Direction.OUTBOUND else {}
    closing = asyncio.Event()

    def mark_closing() -> None:
        if not closing.is_set():
            call_clock["ended"] = time.monotonic()
            closing.set()

    finalize_lock = asyncio.Lock()
    drain_audio_lock = asyncio.Lock()
    drain_audio_attempted = False

    async def play_shutdown_once() -> None:
        nonlocal drain_audio_attempted
        if drain_requested is None or not drain_requested.is_set() or on_drain is None:
            return
        async with drain_audio_lock:
            if drain_audio_attempted:
                return
            drain_audio_attempted = True
            try:
                await on_drain()
            except Exception as error:
                logger.warning("Shutdown audio failed (error_type={})", type(error).__name__)

    async def finish_shutdown_attempt() -> bool:
        # The teardown helper retries false results. Completion means the fixed
        # announcement attempt settled; audibility remains a separate live check.
        await play_shutdown_once()
        return True

    finalized = False
    # Bound, not inline: its open interruption needs settling at call end.
    turn_taking_observer = TurnTakingObserver(turn_taking)
    quality_observer = VoiceQualityObserver(llm=llm, tts=tts, transport_output=transport.output())
    # Pipecat's own caller-stop -> bot-speaking attribution, which names the
    # parts no processor reports a metric for: the VAD silence, the endpointing
    # wait, the sentence aggregation before the first synthesis request. Its
    # parts sum to the measured total, so it answers "which component owns this
    # second" without a second hand-rolled timing layer. Needs enable_metrics,
    # which pipeline_params() already sets. None while tracing owns the stack.
    latency_observer = component_latency_observer(
        quality_observer, tracing_enabled=st.tracing_enabled
    )
    observers: list[BaseObserver] = [
        UsageObserver(usage),
        turn_taking_observer,
        quality_observer,
        *([latency_observer] if latency_observer is not None else []),
        # Raw LLM token events use Pipecat's optional NLTK sentence matcher.
        # NLTK is intentionally removed from the runtime image while its
        # unpatched security advisory remains open. The final bot-output/TTS,
        # speaking, transcription and metrics events stay enabled.
        RTVIObserver(
            rtvi,
            params=RTVIObserverParams(metrics_enabled=True, bot_llm_enabled=False),
        ),
    ]
    if text_diagnostics is not None:
        observers.append(ModelTextDiagnosticsObserver(text_diagnostics, llm))

    worker = PipelineWorker(
        Pipeline(processors),
        params=pipeline_params(),
        idle_timeout_secs=st.agent_idle_timeout_secs,
        observers=observers,
        enable_tracing=st.tracing_enabled,
        conversation_id=str(ctx.session_id),
        additional_span_attributes=conversation_span_attributes(ctx),
    )
    flow_manager = FlowManager(
        worker=worker,
        # pipecat's parameter is typed against the generic base, which pyrefly
        # resolves too narrowly.
        # pyrefly: ignore[bad-argument-type]
        llm=llm,
        context_aggregator=context_aggregator,
        transport=transport,
    )
    transfer_action = make_transfer_action(
        room=room,
        url=st.livekit_url,
        api_key=st.livekit_api_key.get_secret_value(),
        api_secret=st.livekit_api_secret.get_secret_value(),
        on_failure=on_failure,
        sip_refer_supported=ctx.sip_refer_supported,
    )

    async def guarded_transfer(action, manager):
        if voice_control is not None:
            await voice_control.action(transfer_action, action, manager)
        else:
            await transfer_action(action, manager)

    flow_manager.register_action(ActionType.transfer, guarded_transfer)

    # SessionsClient is best-effort — it logs and returns falsy rather than raising,
    # so a persistence outage degrades reporting but never propagates into the call.
    # Store is built once here and injected — nothing downstream reads settings.
    store = build_artifact_store(
        st.artifacts_backend,
        bucket=st.artifacts_bucket,
        local_root=st.artifacts_local_root,
    )
    if uses_http_sessions and not st.sessions_api_key:
        logger.warning(
            "SESSIONS_API_KEY is unset — the sessions API enforces tenancy, so writes "
            "will 401 and no session rows will be recorded for this call."
        )
    # The model that will actually run, not the Vertex field: on openai-compat
    # that one is unused, so checking it clears an evaluation model as priced and
    # the call reports a cost of 0 without ever saying why.
    running_llm = (
        st.llm_model if st.llm_provider is LlmProvider.OPENAI_COMPAT else st.vertex_llm_model
    )
    if unpriced := PriceBook().unpriced_models(llm=running_llm, tts=st.tts_model):
        logger.warning(
            "no rate for {} — this call's usage is recorded but its cost reads as 0. "
            "Add the rate to PriceBook.",
            unpriced,
        )
    recorder = SessionRecorder(sessions, ctx, store)

    # Transcript capture: the aggregators have already assembled a full utterance
    # by the time these fire, so there are no fragments to reassemble.
    @context_aggregator.user().event_handler("on_user_turn_stopped")
    async def on_user_turn_stopped(aggregator, strategy, message):
        if message.content:
            # The turn a lead value may cite, and the turn a "saved" must answer.
            accepted_turns.accept()
            if text_diagnostics is not None:
                text_diagnostics.record_stt(message.content, conversation_language.current)
            await transcript_handler.save_message(
                TranscriptMessage(
                    role="user",
                    content=message.content,
                    timestamp=getattr(message, "timestamp", None),
                )
            )
            if voice_memory is not None:
                try:
                    async with asyncio.timeout(1.0):
                        await voice_memory.final_turn(message.content)
                except Exception:
                    logger.warning("canonical voice memory turn capture unavailable")

    # A turn VAD opened that no transcript ever closed. pipecat force-closes it
    # after `user_turn_stop_timeout` WITHOUT triggering inference, so the caller's
    # turn is discarded in silence — on 2026-08-04 the only trace was the caller
    # saying "אמרתי שאף אחד" into the recording ten seconds later.
    @context_aggregator.user().event_handler("on_user_turn_stop_timeout")
    async def on_user_turn_dropped(_aggregator):
        logger.warning("user turn dropped — no transcript before the stop timeout")
        # The frame that opened it already reset the countdown, so without this
        # the caller waits a further full interval for a turn nobody heard.
        user_idle.abandon_user_turn()

    @context_aggregator.assistant().event_handler("on_assistant_turn_stopped")
    async def on_assistant_turn_stopped(aggregator, message):
        if message.content:
            if text_diagnostics is not None:
                text_diagnostics.record_delivered(message.content)
            await transcript_handler.save_message(
                TranscriptMessage(
                    role="assistant",
                    content=message.content,
                    timestamp=getattr(message, "timestamp", None),
                    interrupted=getattr(message, "interrupted", False),
                )
            )

    @audiobuffer.event_handler("on_audio_data")
    async def on_audio_data(_buffer, audio, sample_rate, num_channels):
        await save_audio_file(audio, session_dir.recording, sample_rate, num_channels)

    async def finalize_once(status: SessionStatus) -> bool:
        """Flush artifacts, upload them, then close the session row. Runs once —
        both exit paths funnel through here."""
        nonlocal finalized
        async with finalize_lock:
            if finalized:
                return True
            if (joined := call_clock.get("joined")) is not None:
                usage.call_seconds = call_clock.get("ended", time.monotonic()) - joined
            # stop_recording triggers on_audio_data; give it a moment to land before
            # the upload walks the directory (jpost does the same).
            await audiobuffer.stop_recording()
            await asyncio.sleep(2)
            if not await transcript_handler.finalize():
                # Keep staging for the retry; a failed final write must not
                # publish an incomplete journal and then remove its recovery copy.
                return False
            if text_diagnostics is not None:
                try:
                    await text_diagnostics.finalize(quality_observer.snapshot())
                except OSError:
                    logger.warning("voice text diagnostics could not be persisted")
            turn_taking_observer.settle_open_interruption()
            logger.info(
                f"interruptions={turn_taking.interruptions} "
                f"wordless={turn_taking.wordless_interruptions} (session={ctx.session_id})"
            )
            # Commit the customer-visible recording, transcript, outcome and
            # answered state before optional diagnostics. Every retained live
            # call had a quality event but NULL artifact pointers because the
            # room-finished cancellation could land between these two writes.
            # Upload first so the database never advertises a missing object.
            quality_summary = quality_observer.finalize()
            try:
                stage_quality_snapshot(session_dir.path, quality_summary)
            except OSError, ValueError:
                logger.warning("voice quality recovery artifact unavailable")
            if not await store.upload_dir(str(session_dir.path), ctx.session_id):
                logger.error("canonical voice artifacts were not persisted")
                return False
            # The node the flow was sitting on when the call ended. On a terminal
            # node that is the business result — the flow names its own endings, so
            # nothing has to be inferred from the transcript later. On any other node
            # the call ended early, and the name says where it stopped.
            finalized = await recorder.finish(
                status,
                usage,
                answered=pickup.get("answered"),
                outcome=flow_manager.current_node,
            )
            if not finalized:
                logger.error("canonical voice session finalization was not persisted")
                return False
            if voice_memory is not None:
                try:
                    async with asyncio.timeout(1.0):
                        await voice_memory.finish()
                except Exception:
                    logger.warning("canonical voice memory end checkpoint unavailable")
            # Quality is valuable but derived. It must never be able to win a
            # race while the canonical conversation record is still incomplete.
            quality_writer = getattr(sessions, "record_voice_quality", None)
            quality_alert = getattr(sessions, "report_voice_quality_failure", None)

            async def write_quality() -> None:
                if quality_writer is None:
                    raise RuntimeError("voice quality writer is unavailable")
                await quality_writer(ctx, quality_summary, agent_version_id=agent_version_id)

            async def report_quality_failure() -> None:
                if quality_alert is None:
                    raise RuntimeError("voice quality failure reporter is unavailable")
                await quality_alert(ctx, reason="summary_persistence_unavailable")

            await persist_quality_summary(
                write_quality, report_quality_failure if quality_alert is not None else None
            )
            try:
                session_dir.cleanup(artifacts_uploaded=True, session_finalized=finalized)
            except OSError, ValueError:
                logger.warning("finalized voice staging cleanup unavailable")
            return finalized

    async def finalize(status: SessionStatus) -> bool:
        """Commit artifacts after the runner has drained its producer callbacks.

        The call owner alone publishes the finished artifact. Repeated room
        cancellation cannot interrupt its filesystem upload or database commit.
        """
        # Wake a ringing join handler before artifact I/O, so teardown cannot
        # race an answer timeout into a late greeting or restart its talk clock.
        mark_closing()
        return await finish_after_cancellation(lambda: finalize_once(status))

    # Canonical LiveKit handlers: start when the first human joins; tear down on disconnect.
    @transport.event_handler("on_first_participant_joined")
    async def on_first_participant_joined(transport, participant_id):
        logger.info(f"Participant joined {participant_id} (session={ctx.session_id})")
        if closing.is_set():
            return
        # Outbound only: joining the room means "dialling", not "answered", so
        # everything below would otherwise run at the phone's first ring — the
        # greeting into a dead line, and the ring counted as talk time.
        if ctx.direction is Direction.OUTBOUND:
            # Recorded, not just awaited: on timeout the bot greets anyway (see
            # wait_until_answered), so without persisting this a call that rang
            # out to nobody finalizes exactly like a conversation — and the
            # campaign reports the number as called.
            pickup["answered"] = await wait_until_answered(
                transport, timeout_secs=st.answer_timeout_secs, closing=closing
            )
        if closing.is_set():
            return
        # Talk time is measured between these two handlers, not from the row's
        # created_at/ended_at: ended_at is stamped after the artifact upload.
        call_clock["joined"] = time.monotonic()
        recorder.start_usage_reporting(usage, started_at=call_clock["joined"])
        await audiobuffer.start_recording()
        if closing.is_set():
            return
        # Only now is there anyone to be silent: the pipeline has been running
        # since the bot joined the room, which outbound precedes the ring.
        user_idle.arm()
        if voice_control is not None:
            await voice_control.refresh()
            if closing.is_set():
                return
            worker.create_task(voice_control.run())
        action_guard = voice_control.action if voice_control else None
        runtime_factories = (
            (
                support_ticket_function_factory(
                    sessions,
                    ctx,
                    ticket_receipt_state,
                    action_guard,
                ),
            )
            if ticket_enabled
            else ()
        )
        if service_intake is not None:
            runtime_factories += service_intake.factories(action_guard)
        entry = initial_node_from_spec(
            spec,
            action_guard=action_guard,
            runtime_function_factories=runtime_factories,
            call_functions=lead_tools.functions(action_guard) if lead_tools else (),
        )
        if verification_requirements is not None:
            if verify_identity is None or load_handoff_context is None:
                raise StoredFlowUnavailable("secure handoff verification runtime is unavailable")

            async def submit_identity(values: dict[str, object]) -> dict:
                result = await verify_identity(ctx, values)
                if isinstance(result.get("state"), str):
                    verification_runtime_state["state"] = result["state"]
                    if text_diagnostics is not None:
                        text_diagnostics.set_verification_state(result["state"])
                return result

            async def fetch_unlocked_context() -> dict:
                unlocked = await load_handoff_context(ctx)
                if service_intake is not None:
                    service_context = await service_intake.refresh_context()
                    return {**unlocked, "serviceIntake": service_context}
                return unlocked

            if verification_requirements.state == "context_unlocked":
                entry = unlocked_handoff_entry(entry, await fetch_unlocked_context())
            else:
                entry = identity_verification_entry(
                    verification_requirements,
                    entry,
                    verify=submit_identity,
                    load_context=fetch_unlocked_context,
                    action_guard=action_guard,
                    send_sms=(lambda: sessions.send_caller_sms(ctx))
                    if hasattr(sessions, "send_caller_sms")
                    else None,
                )
        if closing.is_set():
            return
        await flow_manager.initialize(entry)
        if closing.is_set():
            return
        max_session_seconds = quality.get("budgets", {}).get("maxSessionSeconds", 1800)
        if not isinstance(max_session_seconds, int) or isinstance(max_session_seconds, bool):
            max_session_seconds = 1800

        async def enforce_session_budget():
            await asyncio.sleep(max(60, min(3600, max_session_seconds)))
            logger.info("voice session duration budget reached (session={})", ctx.session_id)
            mark_closing()
            await hangup_room(
                room,
                url=st.livekit_url,
                api_key=st.livekit_api_key.get_secret_value(),
                api_secret=st.livekit_api_secret.get_secret_value(),
            )
            await worker.cancel()

        worker.create_task(enforce_session_budget())
        # Vertex is excluded, not merely unhelpful there: it cached 0 tokens across
        # 39 sessions, so warming it spends a whole extra inference for nothing —
        # and races the caller's first real request while doing it.
        if st.llm_warmup and st.llm_provider is LlmProvider.OPENAI_COMPAT and voice_control is None:
            # After initialize, because only then does the context hold the first
            # node's prompt and tools. Not awaited: the node's opener is already
            # speaking, and a caller who talks over it must not wait on a
            # throwaway request. create_task is pipecat's, so it is held against
            # GC and cancelled with the pipeline.
            llm.create_task(warm_prompt_cache(llm, context))

    @transport.event_handler("on_participant_left")
    async def on_participant_left(transport, participant_id, reason):
        # These identities are minted only by the dispatcher for fixed local
        # lifecycle audio. Their disconnect must not end the caller's session.
        if participant_id in {
            "oron-busy",
            "oron-goodbye",
            "oron-failure",
            "oron-unavailable",
            "oron-recovery",
        }:
            return
        # Outside these internal lifecycle identities, the SIP caller remains
        # the only admitted remote participant. Observer/browser token issuance
        # is still unreachable in production and guarded by the source canary.
        logger.info(
            f"Participant left {participant_id} ({reason}), ending session={ctx.session_id}"
        )
        # cancel() only queues CancelFrame. Aggregators emit their final turns
        # while it drains; uploading here would miss them and remove their file.
        mark_closing()
        await worker.cancel()

    async def announce_runtime_failure() -> None:
        # Setup failure before a caller joined must not create a new room leg.
        if not closing.is_set() and "joined" in call_clock and on_failure is not None:
            await on_failure()

    async def prepare_runtime_recovery(_frame: ErrorFrame) -> bool:
        if closing.is_set():
            return False
        # The interruption barrier already discarded the old model/audio turn.
        # A synthesis reset must not resend text whose audio may have played.
        if isinstance(tts, SonioxUnpointedContextTTSService):
            await tts.prepare_recovery()
        # VoiceFailurePolicy establishes fresh capture through the controller
        # before the repeat prompt; waiting on the old reconnect here would
        # duplicate that work and consume the bounded recovery window.
        return not closing.is_set()

    async def announce_runtime_recovery() -> None:
        if closing.is_set() or "joined" not in call_clock or on_recovery is None:
            raise ConnectionError("Caller is unavailable for voice recovery")
        await on_recovery()
        if closing.is_set():
            raise ConnectionError("Caller left during voice recovery")

    runtime_failure = VoiceFailurePolicy(
        voice_control,
        worker.cancel,
        announce_runtime_failure,
        interrupt_reply=voice_control.interrupt_reply if voice_control is not None else None,
        providers=(stt, llm, tts),
        prepare_recovery=prepare_runtime_recovery,
        announce_recovery=announce_runtime_recovery if on_recovery is not None else None,
    )

    @worker.event_handler("on_pipeline_error")
    async def on_pipeline_error(_worker, frame):
        if frame.processor is not None:
            logger.warning("voice pipeline error (session={})", ctx.session_id)
            await runtime_failure.handle(frame)

    # The other way a call ends: the flow reached a terminal node and
    # end_conversation stopped the pipeline. on_participant_left never fires —
    # nobody left — so without this the agent records nothing and the SIP leg
    # stays up with dead air until LiveKit reaps the empty room. This callback
    # precedes processor cleanup, so only the runner's owner finalizes artifacts.
    @worker.event_handler("on_pipeline_finished")
    async def on_pipeline_finished(worker, frame):
        logger.info(f"Pipeline finished, ending session={ctx.session_id}")
        mark_closing()
        await play_shutdown_once()
        await hangup_room(
            room,
            url=st.livekit_url,
            api_key=st.livekit_api_key.get_secret_value(),
            api_secret=st.livekit_api_secret.get_secret_value(),
        )

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    bind_pipeline_readiness(
        worker, ready, on_failure=lambda: setattr(runtime_failure, "failed", True)
    )
    runner_task: asyncio.Task[None] | None = None

    async def drain_pipeline() -> bool:
        # Never wait for this from a processor event: Pipecat cleanup itself
        # awaits those handlers. The call owner waits until all aggregators and
        # their asynchronous final-turn callbacks have completed instead.
        if runner_task is not None and not runner_task.done():
            await worker.cancel()
            try:
                await asyncio.shield(runner_task)
            except asyncio.CancelledError:
                if not runner_task.cancelled():
                    raise
            except Exception:
                logger.error("voice pipeline cleanup failed; retaining artifact staging")
                return False
        if runner_task is not None and (
            runner_task.cancelled() or runner_task.exception() is not None
        ):
            # Runner setup can fail after starting a worker but before entering
            # its cleanup block. A failed task is not proof the writers drained.
            logger.error("voice pipeline cleanup unconfirmed; retaining artifact staging")
            return False
        return True

    try:
        # Establish/acknowledge the session before pipeline startup can admit a
        # SIP leg. Joining outbound is only dialling: waiting for pickup first
        # left early departures with no recorder row and unpersistable teardown.
        # This does not start recording, report talk time, or imply an answer.
        await recorder.start(room=room)
        runner_task = asyncio.create_task(runner.run(), name=f"voice-pipeline-{ctx.session_id}")
        await asyncio.shield(runner_task)
        mark_closing()
        if runtime_failure.failed:
            raise RuntimeError("voice pipeline lost a required processor")
        await finalize(SessionStatus.ENDED)
    except asyncio.CancelledError:
        # A room-finished webhook can cancel this task before the transport's
        # participant-left callback completes. Preserve the call's private
        # artifacts and usage before propagating cancellation to the dispatcher.
        mark_closing()
        await finish_after_cancellation(finish_shutdown_attempt)
        if await finish_after_cancellation(drain_pipeline):
            await finalize(SessionStatus.ENDED)
        raise
    except Exception as error:
        # The agent knows the call failed right now. Without this the row sits at
        # `started` until the sweeper ages it out, up to STALE_SESSION_MINUTES later.
        logger.error(
            "agent run failed (session={}, error_type={})", ctx.session_id, type(error).__name__
        )
        # Still upload: a call that died may have produced a partial transcript
        # or recording, and that is exactly what you want when debugging it.
        mark_closing()
        if await finish_after_cancellation(drain_pipeline):
            await finalize(SessionStatus.FAILED)
        raise
    finally:
        await recorder.aclose()


async def run_call(
    room_name: str,
    ctx: CallContext,
    st: Settings | None = None,
    *,
    g2p: G2P | None = None,
    overrides: AgentOverrides | None = None,
    sessions: RuntimeSessions | None = None,
    ready: asyncio.Event | None = None,
    drain_requested: asyncio.Event | None = None,
    on_drain: Callable[[], Awaitable[None]] | None = None,
    on_failure: Callable[[], Awaitable[None]] | None = None,
    on_recovery: Callable[[], Awaitable[None]] | None = None,
) -> None:
    """Join `room_name` as the agent and run the pipeline for one call.

    The dispatcher calls this with a per-call room; `bot()` calls it with the
    fixed dev room. `overrides` arrive unmerged and are applied inside, on top
    of whatever voice the flow itself asks for.
    """
    st = st or load_settings()
    require_real_voice_providers(st)
    token = mint_room_token(
        st.livekit_api_key.get_secret_value(),
        st.livekit_api_secret.get_secret_value(),
        room=room_name,
        identity="oron-agent",
    )
    audio_in_filter = await build_audio_in_filter(
        st.audio_in_filter,
        krisp_api_key=st.krisp_api_key.get_secret_value(),
        krisp_filter_model_path=st.krisp_filter_model_path,
    )
    params = build_transport_params(ctx, audio_in_filter=audio_in_filter)["livekit"]()  # DI factory
    transport = LiveKitTransport(
        url=st.livekit_url, token=token, room_name=room_name, params=params
    )
    await run_bot(
        transport,
        ctx,
        st,
        room=room_name,
        g2p=g2p,
        overrides=overrides,
        sessions=sessions,
        ready=ready,
        drain_requested=drain_requested,
        on_drain=on_drain,
        on_failure=on_failure,
        on_recovery=on_recovery,
    )


async def bot(ctx: CallContext | None = None, *, g2p: G2P | None = None):
    st = load_settings()
    # session_id defaults to a fresh UUID (CallContext). One room = one session for M1.
    if ctx is None:
        # No dispatcher means no DID binding. The operator must still select a
        # published tenant flow; silently running fictional packaged behavior is
        # unsafe on a real voice transport.
        if st.dev_flow_id is None or st.dev_tenant_id is None:
            raise RuntimeError(
                "FLOW_ID and TENANT_ID are required for the dispatcher-less voice-agent "
                "entrypoint; set them to a published flow and its owning tenant"
            )
        ctx = CallContext(
            call_id=st.livekit_room,
            provider="livekit",
            direction="inbound",
            flow_id=st.dev_flow_id,
            tenant_id=st.dev_tenant_id,
        )
    await run_call(st.livekit_room, ctx, st, g2p=g2p)


def main():
    from oron_secrets import hydrate_env_from_secret_manager

    hydrate_env_from_secret_manager()  # resolve SECRET__* refs before settings load
    st = load_settings()
    # The dispatcher installs this for the deployed path; without it here, this
    # entrypoint builds spans against the no-op provider and exports nothing,
    # while TurnTraceObserver still logs that it started and ended each turn.
    if st.tracing_enabled:
        setup_process_tracing(service_name="oron-agent", endpoint=st.otlp_endpoint)
    # Loaded before any call arrives — see run_bot.
    asyncio.run(
        bot(
            g2p=build_g2p(
                st.renikud_model_path,
                expected_sha256=st.renikud_model_sha256,
            )
        )
    )


if __name__ == "__main__":
    main()
