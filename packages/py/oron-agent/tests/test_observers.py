"""Which observers a call actually registers.

Exists because a regex edit silently dropped RTVIObserver from the list and
every test still passed: nothing asserted the pipeline's own wiring.
"""

import inspect

from oron_agent import bot
from oron_agent.quality_observer import VoiceQualityObserver, component_latency_observer
from pipecat.observers.user_bot_latency_observer import (
    LatencyBreakdown,
    LatencyContribution,
    LatencyOwnerKind,
    MeasuredFrom,
    UserBotLatencyObserver,
)
from pipecat.processors.frame_processor import FrameProcessor


class _P(FrameProcessor):
    """A distinct processor identity; the observer only compares by identity."""


def test_the_rtvi_observer_is_registered():
    """It carries transcripts and TTFB onto the transport's data channel — drop
    it and the console's live captions go quiet, with nothing failing."""
    src = inspect.getsource(bot.run_bot)
    assert "RTVIObserver(" in src
    assert "rtvi," in src


def test_rtvi_does_not_require_the_removed_nltk_runtime_dependency():
    """Final bot output remains observable without Pipecat's raw-token sentence matcher."""
    src = inspect.getsource(bot.run_bot)
    assert "bot_llm_enabled=False" in src


def test_pipecat_owns_the_tracing_stack():
    """We built TurnTrackingObserver, UserBotLatencyObserver and TurnTraceObserver
    by hand and passed them in `observers=[…]`. That produced orphan turns and no
    LLM/TTS/STT spans, because only `enable_tracing` reaches StartFrame and only
    pipecat's own observer gets end_conversation_tracing() at shutdown."""
    src = inspect.getsource(bot.run_bot)
    assert "enable_tracing=st.tracing_enabled" in src
    assert "conversation_id=" in src
    assert "TurnTrackingObserver()" not in src
    assert "TurnTraceObserver(" not in src
    # The latency observer is the one member of that stack we do register, and
    # only where pipecat builds none — see the behavioural test below.
    assert "UserBotLatencyObserver()" not in src


def test_the_component_latency_observer_yields_to_pipecats_tracing_stack():
    """`PipelineWorker` builds its own UserBotLatencyObserver under
    `enable_tracing` and exposes no accessor for it, so a second one would
    double-observe every frame for a breakdown the spans already carry."""
    quality = VoiceQualityObserver(llm=_P(), tts=_P(), transport_output=_P())

    assert component_latency_observer(quality, tracing_enabled=True) is None
    assert isinstance(
        component_latency_observer(quality, tracing_enabled=False), UserBotLatencyObserver
    )


def _breakdown(*durations: float) -> LatencyBreakdown:
    keys = ("endpointing_wait", "llm_inference")
    return LatencyBreakdown(
        total_secs=sum(durations),
        measured_from=MeasuredFrom.USER_SILENCE,
        contributions=[
            LatencyContribution(
                key=key,
                label=key.replace("_", " "),
                owner="config: VAD stop_secs" if key == "endpointing_wait" else "LLMService#0",
                owner_kind=(
                    LatencyOwnerKind.SETTING
                    if key == "endpointing_wait"
                    else LatencyOwnerKind.SERVICE
                ),
                start_time=0.0,
                duration_secs=seconds,
            )
            for key, seconds in zip(keys, durations, strict=True)
        ],
    )


async def test_the_component_breakdown_becomes_percentiles_in_the_quality_artifact():
    """The artifact is where a call's latency evidence is read back, and the
    summary is keyed on the contribution KEY so a reworded label cannot split
    one component's history into two series."""
    quality = VoiceQualityObserver(llm=_P(), tts=_P(), transport_output=_P())

    await quality.record_latency_breakdown(_breakdown(0.2, 1.05))
    await quality.record_latency_breakdown(_breakdown(0.3, 0.55))
    component = quality.snapshot()["component_latency"]

    assert component["summary_ms"]["total"] == {"samples": 2, "p50": 850.0, "p95": 1250.0}
    assert component["summary_ms"]["endpointing_wait"]["p50"] == 200.0
    assert component["summary_ms"]["llm_inference"]["p95"] == 1050.0
    # Timing and ownership only: a breakdown must never carry what was said.
    assert component["cycles"][0]["contributions"][0]["owner_kind"] == "setting"


async def test_the_breakdown_handler_is_a_coroutine_function_so_pipecat_awaits_it():
    """`_run_handler` awaits a handler only when `iscoroutinefunction` holds.
    A lambda returning a coroutine is called and discarded, and the breakdown
    vanishes with nothing failing — which is how this was first written."""
    quality = VoiceQualityObserver(llm=_P(), tts=_P(), transport_output=_P())
    observer = component_latency_observer(quality, tracing_enabled=False)
    assert observer is not None

    handlers = observer._event_handlers["on_latency_breakdown"].handlers

    assert handlers, "no handler registered for on_latency_breakdown"
    assert all(inspect.iscoroutinefunction(handler) for handler in handlers)
    await handlers[0](observer, _breakdown(0.2, 1.05))
    assert quality.snapshot()["component_latency"]["summary_ms"]["total"]["p50"] == 1250.0


def test_the_prompt_cache_warmup_runs_after_the_flow_has_a_prompt_to_warm():
    """Before `initialize` the context is empty, so a warm-up there would cache a
    prefix no real turn ever sends — the request costs money and buys nothing.
    It must also not be awaited: the node's opener is speaking, and a caller who
    talks over it cannot wait on a throwaway request."""
    src = inspect.getsource(bot.run_bot)
    assert "st.llm_warmup" in src
    init = src.index("flow_manager.initialize")
    warm = src.index("warm_prompt_cache")
    assert init < warm
    assert "await warm_prompt_cache" not in src


def test_the_warmup_is_skipped_on_a_provider_that_does_not_cache():
    """Vertex cached 0 tokens across 39 sessions, so warming it spends a whole
    extra inference for no cache benefit — and races the caller's first real
    request while doing it. The flag alone is not the gate: `vertex` is the code
    default, so a bare `if st.llm_warmup` warms every ordinary call for nothing.

    Asserted as the whole condition: `st.llm_provider is LlmProvider.OPENAI_COMPAT`
    alone also matches the unrelated `running_llm` line above, which made an
    earlier version of this test pass with the gate deleted."""
    src = inspect.getsource(bot.run_bot)
    assert (
        "if st.llm_warmup and st.llm_provider is LlmProvider.OPENAI_COMPAT "
        "and voice_control is None:" in src
    )


def test_the_standalone_entrypoint_installs_the_exporter():
    """`main` is the dev path; the dispatcher is the deployed one. Only the
    dispatcher called setup_process_tracing, so `uv run oron-agent` built spans
    against the no-op provider and exported nothing — while TurnTraceObserver
    still logged that it started and ended every turn."""
    src = inspect.getsource(bot.main)
    assert "setup_process_tracing" in src
    assert "tracing_enabled" in src
