"""Which observers a call actually registers.

Exists because a regex edit silently dropped RTVIObserver from the list and
every test still passed: nothing asserted the pipeline's own wiring.
"""

import inspect

from oron_agent import bot


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
    assert "UserBotLatencyObserver()" not in src


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
