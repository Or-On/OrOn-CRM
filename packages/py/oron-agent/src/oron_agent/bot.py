import asyncio
import time

from dotenv import load_dotenv
from loguru import logger
from oron_common import CallContext, CallUsage, Direction, PriceBook, carrier_for
from oron_flows import FlowVoice
from oron_flows.node import ActionType
from oron_hebrew import build_g2p, make_hebrew_niqqud_transformer
from oron_hebrew.filters import HebrewNormalizeFilter
from oron_hebrew.gender_audio_ecapa import GenderClassifierProcessor
from oron_sessions import SessionsClient, SessionStatus
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.flows import FlowManager
from pipecat.frames.frames import LLMMessagesAppendFrame
from pipecat.observers.base_observer import BaseObserver
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frameworks.rtvi import RTVIObserver, RTVIObserverParams, RTVIProcessor
from pipecat.services.soniox.stt import SonioxSTTService

# Pinned (Pipecat 1.5.0): LiveKitTransport lives in .transport, NOT the package top level.
from pipecat.transports.livekit.transport import LiveKitTransport
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import (
    SpeechTimeoutUserTurnStopStrategy,
)
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter
from pipecat.workers.runner import WorkerRunner
from renikud_onnx import G2P

from oron_agent.answered import wait_until_answered
from oron_agent.artifacts import SessionDir
from oron_agent.audio import TurnEnd, build_audio_in_filter, build_turn_start_strategy
from oron_agent.audio_buffer import AlignedAudioBufferProcessor
from oron_agent.bot_speaking import BotSpeakingObserver
from oron_agent.config import AgentOverrides, Settings, load_settings, settings_for_call
from oron_agent.cost import UsageObserver
from oron_agent.flows import initial_node_from_spec
from oron_agent.flows.resolve import resolve_flow_spec
from oron_agent.hangup import hangup_room
from oron_agent.hold_opener import HoldOpener
from oron_agent.idle import UserIdlePoker
from oron_agent.language import language_profile
from oron_agent.llm import LlmProvider, build_llm, warm_prompt_cache
from oron_agent.pipeline import build_agent_processors
from oron_agent.session_recorder import SessionRecorder
from oron_agent.storage import build_artifact_store, save_audio_file
from oron_agent.tokens import mint_room_token
from oron_agent.tracing import conversation_span_attributes, setup_process_tracing
from oron_agent.transcript import TranscriptHandler, TranscriptMessage
from oron_agent.transfer import make_transfer_action
from oron_agent.transport import build_transport_params
from oron_agent.tts import TtsProvider, build_tts
from oron_agent.tts_trim import TrimLeadingSilence
from oron_agent.turn_taking import TurnTaking, TurnTakingObserver

load_dotenv()


class RealVoiceProvidersDenied(RuntimeError):
    """Provider-backed voice execution was not explicitly enabled."""


def require_real_voice_providers(settings: Settings) -> None:
    if not settings.enable_real_voice_providers:
        raise RealVoiceProvidersDenied("real voice providers are disabled")


def build_user_aggregator_params(st: Settings) -> LLMUserAggregatorParams:
    """Turn-taking: Silero VAD detects speech; a turn STARTS on speech and STOPS
    after a short silence, so the utterance is flushed to the LLM.

    Under `TURN_END=soniox` the strategies are left unset on purpose. A service
    may only recommend strategies when the caller passed none — ours always win
    and Soniox's recommendation is dropped with a debug line — so passing any
    here silently keeps our own floor while Soniox also emits turn frames.
    """
    vad = SileroVADAnalyzer(
        params=VADParams(
            stop_secs=st.vad_stop_secs,
            confidence=st.vad_confidence,
            min_volume=st.vad_min_volume,
        )
    )
    if st.turn_end is TurnEnd.SONIOX:
        return LLMUserAggregatorParams(vad_analyzer=vad)
    return LLMUserAggregatorParams(
        vad_analyzer=vad,
        user_turn_strategies=UserTurnStrategies(
            # Exactly one: the controller ignores every trigger after the first in
            # a turn, and VAD always fires before a transcript exists.
            start=[
                build_turn_start_strategy(
                    st.turn_start,
                    min_words=st.interrupt_min_words,
                    krisp_api_key=st.krisp_api_key.get_secret_value(),
                    krisp_ip_model_path=st.krisp_ip_model_path,
                )
            ],
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
):
    # `room`, never `st.livekit_room`: the dispatcher runs every call in-process
    # against one shared Settings, so that field holds a deployment-wide default
    # and not the room this call is in.
    # Given, not reloaded: a per-call copy carries the console's tuned knobs, and
    # reloading here would quietly discard them.
    st = st or load_settings()
    logger.info(f"Starting oron-agent (session={ctx.session_id}, room={room})")

    sessions = SessionsClient(
        st.sessions_api_url,
        api_key=st.sessions_api_key.get_secret_value() if st.sessions_api_key else None,
    )
    spec = await resolve_flow_spec(sessions, ctx)
    # Only now is the flow known, so only now can its voice be applied — under
    # the console's per-call knobs, over the deployment's defaults. The sessions
    # client above is built from credentials no override may touch.
    st = settings_for_call(st, spec.voice, overrides)
    profile = language_profile(spec.language)

    stt = SonioxSTTService(
        api_key=st.soniox_api_key.get_secret_value(),
        # True is pipecat mode: Soniox's own endpoint detection is DISABLED and
        # our VAD + speech timeout decide the turn. False hands the decision to
        # the model.
        vad_force_turn_endpoint=st.turn_end is TurnEnd.VAD,
        settings=SonioxSTTService.Settings(
            language_hints=profile.stt_hints, language_hints_strict=True
        ),
    )
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
        request_timeout_secs=st.llm_request_timeout_secs,
    )

    # Hebrew wiring. The G2P sits on the OUTPUT path only: its job is to point
    # the LLM's Hebrew so TTS reads it correctly. Nothing diacritizes caller
    # speech — there is no reason to run G2P before the LLM.
    # g2p is injected, not built here: loading the model costs ~1s, and inside
    # run_bot that lands on a caller who is already connected and hearing silence.

    # ECAPA infers caller gender from the caller's VOICE, in parallel with STT,
    # and feeds BOTH consumers: the G2P (target_speaker, so niqqud points
    # gendered homographs correctly) and the LLM (one appended system line, so
    # it writes gendered verbs correctly). No prompt block asks the model to
    # guess — the answer arrives as context. Local state, not a global.
    caller_gender: dict[str, str | None] = {"value": None}

    async def _on_gender_classified(gender: str, confidence: float) -> None:
        if gender not in ("male", "female"):
            logger.info(f"Caller gender inconclusive ({confidence:.2f}) (session={ctx.session_id})")
            return
        caller_gender["value"] = gender  # -> G2P target_speaker
        logger.info(f"Caller gender: {gender} ({confidence:.2f}) (session={ctx.session_id})")
        # run_llm=False: this is context for the NEXT turn, not a reason to speak.
        await gender_classifier.push_frame(
            LLMMessagesAppendFrame(
                messages=[
                    {
                        "role": "system",
                        "content": (
                            f"The caller is {gender.upper()}. "
                            "Address them using Hebrew forms of that gender."
                        ),
                    }
                ],
                run_llm=False,
            )
        )

    # The observer is constructed first so the classifier can close over its
    # state: inbound audio while the bot speaks is echo, not the caller.
    bot_speaking = BotSpeakingObserver()
    gender_classifier = GenderClassifierProcessor(
        on_gender_classified=_on_gender_classified,
        is_bot_speaking=lambda: bot_speaking.is_speaking,
        model_path=st.ecapa_model_path,
        model_sha256=st.ecapa_model_sha256,
    )

    tts = build_tts(
        st.tts_provider,
        language=profile.tts_language,
        # Per-call first, then the flow's own choice, then the provider's
        # default — the same order the settings merge above follows. The flow's
        # name is dropped when an override moved the provider away from the one
        # it named: voice names are per-vendor namespaces, so "Leda" reaching
        # Soniox is a 400 on the first utterance of a live call.
        voice=ctx.tts_voice or _flow_voice_for(spec.voice, st.tts_provider) or st.tts_voice_default,
        # Markdown first: the model emits **bold** and "* " bullets despite being
        # told not to, and TTS voices the asterisks. Heard live 2026-07-26.
        # HebrewNormalizeFilter then does the spoken-form rules and drops emoji.
        text_filters=[MarkdownTextFilter(), HebrewNormalizeFilter()],
        text_aggregation_mode=st.tts_text_aggregation,
        first_clause=st.tts_first_clause,
        speed=st.tts_speed,
        soniox_api_key=st.soniox_api_key.get_secret_value(),
        soniox_model=st.soniox_tts_model,
        gemini_model=st.gemini_tts_model,
        google_credentials_path=st.google_application_credentials,
    )
    tts.add_text_transformer(
        make_hebrew_niqqud_transformer(
            g2p if st.tts_niqqud else None,
            lambda: caller_gender["value"],
            pronunciations=spec.pronunciations,
        )
    )

    context = LLMContext()
    context_aggregator = LLMContextAggregatorPair(
        context,
        user_params=build_user_aggregator_params(st),
    )
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
    processors = build_agent_processors(
        transport.input(),
        stt,
        context_aggregator.user(),
        llm,
        tts,
        transport.output(),
        context_aggregator.assistant(),
        gender_classifier=gender_classifier,
        audio_buffer=audiobuffer,
        tts_trim=TrimLeadingSilence(),
        bot_speaking=bot_speaking,
        hold_opener=HoldOpener(
            lambda: bot_speaking.opener_done, max_hold_secs=st.opener_hold_max_secs
        ),
        user_idle=user_idle,
        rtvi=rtvi,
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
    observers: list[BaseObserver] = [
        UsageObserver(usage),
        turn_taking_observer,
        RTVIObserver(rtvi, params=RTVIObserverParams(metrics_enabled=True)),
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
    flow_manager.register_action(
        ActionType.transfer,
        make_transfer_action(
            room=room,
            url=st.livekit_url,
            api_key=st.livekit_api_key.get_secret_value(),
            api_secret=st.livekit_api_secret.get_secret_value(),
        ),
    )

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
        user_idle.rearm()

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
        await audiobuffer.start_recording()
        # Only now is there anyone to be silent: the pipeline has been running
        # since the bot joined the room, which outbound precedes the ring.
        user_idle.arm()
        await flow_manager.initialize(initial_node_from_spec(spec))
        # Vertex is excluded, not merely unhelpful there: it cached 0 tokens across
        # 39 sessions, so warming it spends a whole extra inference for nothing —
        # and races the caller's first real request while doing it.
        if st.llm_warmup and st.llm_provider is LlmProvider.OPENAI_COMPAT:
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
    await run_bot(transport, ctx, st, room=room_name, g2p=g2p, overrides=overrides)


async def bot(ctx: CallContext | None = None, *, g2p: G2P | None = None):
    st = load_settings()
    # session_id defaults to a fresh UUID (CallContext). One room = one session for M1.
    if ctx is None:
        # No dispatcher, so no DID to bind a flow from: run the packaged default.
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
