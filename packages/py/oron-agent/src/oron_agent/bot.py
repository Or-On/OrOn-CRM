from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING
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
from pipecat.frames.frames import LLMMessagesAppendFrame
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
from oron_agent.idle import UserIdlePoker
from oron_agent.language import language_profile
from oron_agent.llm import LlmProvider, build_llm, warm_prompt_cache
from oron_agent.ownership_stt import OwnershipSonioxSTTService
from oron_agent.pipeline import build_agent_processors
from oron_agent.quality_observer import VoiceQualityObserver
from oron_agent.recognition import RecognitionAcceptanceProcessor
from oron_agent.runtime_sessions import RuntimeSessions
from oron_agent.session_recorder import SessionRecorder
from oron_agent.spoken_safety import BusinessClaimGuardFilter
from oron_agent.storage import build_artifact_store, save_audio_file
from oron_agent.tokens import mint_room_token
from oron_agent.tracing import conversation_span_attributes, setup_process_tracing
from oron_agent.transcript import TranscriptHandler, TranscriptMessage
from oron_agent.transfer import make_transfer_action
from oron_agent.transport import build_transport_params
from oron_agent.tts import TtsProvider, build_tts
from oron_agent.tts_trim import TrimLeadingSilence
from oron_agent.turn_planner import HebrewTurnPlanner
from oron_agent.turn_taking import TurnTaking, TurnTakingObserver
from oron_agent.voice_control import VoiceControlGate, VoiceController, VoiceControlSnapshot
from oron_agent.voice_quality import (
    VoiceQualityConfig,
    build_soniox_context,
    make_speech_transformer,
)
from oron_agent.whatsapp_context import apply_whatsapp_context_to_flow


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
):
    # `room`, never `st.livekit_room`: the dispatcher runs every call in-process
    # against one shared Settings, so that field holds a deployment-wide default
    # and not the room this call is in.
    # Given, not reloaded: a per-call copy carries the console's tuned knobs, and
    # reloading here would quietly discard them.
    st = st or load_settings()
    logger.info(f"Starting oron-agent (session={ctx.session_id}, room={room})")

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

    async def load_knowledge() -> list[dict]:
        if knowledge_reader is None or not agent_version_id:
            return []
        return await knowledge_reader(UUID(agent_version_id), tenant_id=ctx.tenant_id)

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
    if ctx.conversation_context:
        spec = apply_whatsapp_context_to_flow(spec, ctx.conversation_context)
    # Only now is the flow known, so only now can its voice be applied — under
    # the console's per-call knobs, over the deployment's defaults. The sessions
    # client above is built from credentials no override may touch.
    st = settings_for_call(st, spec.voice, overrides)
    profile = language_profile(spec.language)

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
            context=build_soniox_context(quality_config),
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
            BusinessClaimGuardFilter(),
        ],
        text_aggregation_mode=st.tts_text_aggregation,
        first_clause=st.tts_first_clause,
        speed=quality_config.speakingPace if "speakingPace" in quality else st.tts_speed,
        soniox_api_key=st.soniox_api_key.get_secret_value(),
        soniox_model=st.soniox_tts_model,
        gemini_model=st.gemini_tts_model,
        google_credentials_path=st.google_application_credentials,
    )
    tts.add_text_transformer(
        make_speech_transformer(quality_config, lambda: caller_gender.tts_value)
    )
    tts.add_text_transformer(
        make_hebrew_niqqud_transformer(
            g2p if st.tts_niqqud else None,
            lambda: caller_gender.tts_value,
            persona_gender=spec.persona_gender,
            # The platform name appears in retained scripted greetings and
            # never reaches the LLM prompt. Give it a Hebrew spoken form at the
            # final pronunciation boundary; a tenant-authored value still wins.
            pronunciations={"Or-On": "אוֹר אוֹן", **spec.pronunciations},
        )
    )

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
    conversation_language = ConversationLanguageState(spec.language)
    caller_language_context = CallerLanguageContextProcessor(conversation_language)
    response_language = ResponseLanguageTTSProcessor(conversation_language)
    turn_planner = HebrewTurnPlanner()
    # Artifacts are staged locally during the call and uploaded at teardown.
    session_dir = SessionDir(ctx.session_id)
    transcript_handler = TranscriptHandler(output_file=session_dir.transcript)
    # Stereo: caller on the left channel, agent on the right. A mixed mono file
    # cannot be scored for turn-taking, barge-in, or per-speaker audio quality,
    # and the caller-only channel is what gender/turn evals need as input.
    audiobuffer = AlignedAudioBufferProcessor(num_channels=2)
    # Transcripts and TTFB onto the transport's data channel, which is how the
    # dev console watches a call it is not otherwise part of.
    rtvi = RTVIProcessor()

    user_idle = UserIdlePoker(prompts=profile.idle_prompts, timeout_secs=st.user_idle_secs)
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
        language=lambda: conversation_language.current.value,
        load_records=load_knowledge,
        speaking_style=quality_config.speakingStyle,
        fallback_behavior=quality_config.fallbackBehavior,
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
        evidence_context=VoiceEvidenceContext(
            tenant_id=str(ctx.tenant_id),
            language=lambda: conversation_language.current.value,
            load_records=load_knowledge,
            on_caller_text=evidence_gate.observe_caller_text,
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
        ownership_speech=VoiceControlGate(voice_control) if voice_control else None,
        ownership_output=VoiceControlGate(voice_control, audio=True) if voice_control else None,
    )
    if voice_control is not None:
        voice_control.attach(
            processors[1:],
            on_mode=user_idle.set_ai_paused,
            pause_capture=stt.pause_capture,
            reset_utterance=context_aggregator.user().reset,
            resume_capture=stt.resume_capture,
        )
    # Per-call dispatch (M4): the bot joins when a caller is present and should die
    # when the call ends. agent_idle_timeout_secs is the orphan safety net.
    usage = CallUsage(carrier=carrier_for(ctx))
    turn_taking = TurnTaking()
    call_clock: dict[str, float] = {}
    # Outbound pick-up, once known. A dict for the same reason call_clock is one:
    # the transport handlers stay free of `nonlocal`.
    pickup: dict[str, bool] = {}
    # Bound, not inline: its open interruption needs settling at call end.
    turn_taking_observer = TurnTakingObserver(turn_taking)
    quality_observer = VoiceQualityObserver(llm=llm, tts=tts, transport_output=transport.output())
    observers: list[BaseObserver] = [
        UsageObserver(usage),
        turn_taking_observer,
        quality_observer,
        # Raw LLM token events use Pipecat's optional NLTK sentence matcher.
        # NLTK is intentionally removed from the runtime image while its
        # unpatched security advisory remains open. The final bot-output/TTS,
        # speaking, transcription and metrics events stay enabled.
        RTVIObserver(
            rtvi,
            params=RTVIObserverParams(metrics_enabled=True, bot_llm_enabled=False),
        ),
    ]

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
    if not st.sessions_api_key:
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
            await transcript_handler.save_message(
                TranscriptMessage(
                    role="user",
                    content=message.content,
                    timestamp=getattr(message, "timestamp", None),
                )
            )

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

    async def finalize(status: SessionStatus) -> None:
        """Flush artifacts, upload them, then close the session row. Runs once —
        both exit paths funnel through here."""
        if (joined := call_clock.get("joined")) is not None:
            usage.call_seconds = time.monotonic() - joined
        # stop_recording triggers on_audio_data; give it a moment to land before
        # the upload walks the directory (jpost does the same).
        await audiobuffer.stop_recording()
        await asyncio.sleep(2)
        await transcript_handler.finalize()
        quality_writer = getattr(sessions, "record_voice_quality", None)
        if quality_writer is not None:
            try:
                async with asyncio.timeout(2.0):
                    await quality_writer(
                        ctx, quality_observer.finalize(), agent_version_id=agent_version_id
                    )
            except Exception:
                logger.warning("voice quality summary persistence unavailable")
        await store.upload_dir(str(session_dir.path), ctx.session_id)
        turn_taking_observer.settle_open_interruption()
        logger.info(
            f"interruptions={turn_taking.interruptions} "
            f"wordless={turn_taking.wordless_interruptions} (session={ctx.session_id})"
        )
        # The node the flow was sitting on when the call ended. On a terminal
        # node that is the business result — the flow names its own endings, so
        # nothing has to be inferred from the transcript later. On any other node
        # the call ended early, and the name says where it stopped.
        await recorder.finish(
            status,
            usage,
            answered=pickup.get("answered"),
            outcome=flow_manager.current_node,
        )

    # Canonical LiveKit handlers: start when the first human joins; tear down on disconnect.
    @transport.event_handler("on_first_participant_joined")
    async def on_first_participant_joined(transport, participant_id):
        logger.info(f"Participant joined {participant_id} (session={ctx.session_id})")
        # Outbound only: joining the room means "dialling", not "answered", so
        # everything below would otherwise run at the phone's first ring — the
        # greeting into a dead line, and the ring counted as talk time.
        if ctx.direction is Direction.OUTBOUND:
            # Recorded, not just awaited: on timeout the bot greets anyway (see
            # wait_until_answered), so without persisting this a call that rang
            # out to nobody finalizes exactly like a conversation — and the
            # campaign reports the number as called.
            pickup["answered"] = await wait_until_answered(
                transport, timeout_secs=st.answer_timeout_secs
            )
        # Talk time is measured between these two handlers, not from the row's
        # created_at/ended_at: ended_at is stamped after the artifact upload.
        call_clock["joined"] = time.monotonic()
        await recorder.start(room=room)
        recorder.start_usage_reporting(usage, started_at=call_clock["joined"])
        await audiobuffer.start_recording()
        # Only now is there anyone to be silent: the pipeline has been running
        # since the bot joined the room, which outbound precedes the ring.
        user_idle.arm()
        if voice_control is not None:
            await voice_control.refresh()
            worker.create_task(voice_control.run())
        await flow_manager.initialize(
            initial_node_from_spec(
                spec, action_guard=voice_control.action if voice_control else None
            )
        )
        max_session_seconds = quality.get("budgets", {}).get("maxSessionSeconds", 1800)
        if not isinstance(max_session_seconds, int) or isinstance(max_session_seconds, bool):
            max_session_seconds = 1800

        async def enforce_session_budget():
            await asyncio.sleep(max(60, min(3600, max_session_seconds)))
            logger.info("voice session duration budget reached (session={})", ctx.session_id)
            await finalize(SessionStatus.ENDED)
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
        logger.info(
            f"Participant left {participant_id} ({reason}), ending session={ctx.session_id}"
        )
        await finalize(SessionStatus.ENDED)
        await worker.cancel()

    # The other way a call ends: the flow reached a terminal node and
    # end_conversation stopped the pipeline. on_participant_left never fires —
    # nobody left — so without this the agent records nothing and the SIP leg
    # stays up with dead air until LiveKit reaps the empty room. Measured at 37s
    # on 2026-07-27. finalize() is idempotent, so the two paths cannot conflict.
    @worker.event_handler("on_pipeline_finished")
    async def on_pipeline_finished(worker, frame):
        logger.info(f"Pipeline finished, ending session={ctx.session_id}")
        await finalize(SessionStatus.ENDED)
        await hangup_room(
            room,
            url=st.livekit_url,
            api_key=st.livekit_api_key.get_secret_value(),
            api_secret=st.livekit_api_secret.get_secret_value(),
        )

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    # Signal only after every tenant flow, model, STT, TTS, processor and
    # persistence dependency has been constructed.  The dispatcher waits for
    # this boundary before creating a paid SIP participant.
    if ready is not None:
        ready.set()
    try:
        await runner.run()
    except Exception:
        # The agent knows the call failed right now. Without this the row sits at
        # `started` until the sweeper ages it out, up to STALE_SESSION_MINUTES later.
        logger.exception(f"agent run failed (session={ctx.session_id})")
        # Still upload: a call that died may have produced a partial transcript
        # or recording, and that is exactly what you want when debugging it.
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
