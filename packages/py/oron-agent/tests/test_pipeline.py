from oron_agent.pipeline import build_agent_processors
from pipecat.pipeline.parallel_pipeline import ParallelPipeline
from pipecat.processors.frame_processor import FrameProcessor

_PROCESSORS = ("tin", "stt", "ua", "llm", "tts", "tout", "aa")


def test_processor_order_without_gender_classifier():
    tin, stt, ua, llm, tts, tout, aa = _PROCESSORS
    assert build_agent_processors(tin, stt, ua, llm, tts, tout, aa) == [
        tin,
        stt,
        ua,
        llm,
        tts,
        tout,
        aa,
    ]


def test_complete_turn_planner_sits_between_llm_and_tts():
    tin, stt, ua, llm, tts, tout, aa = _PROCESSORS
    processors = build_agent_processors(
        tin,
        stt,
        ua,
        llm,
        tts,
        tout,
        aa,
        turn_planner="turn-planner",
    )

    assert processors == [tin, stt, ua, llm, "turn-planner", tts, tout, aa]


def test_ownership_gates_cover_all_producers_before_buffers():
    tin, stt, ua, llm, tts, tout, aa = _PROCESSORS
    processors = build_agent_processors(
        tin,
        stt,
        ua,
        llm,
        tts,
        tout,
        aa,
        ownership_input="input-gate",
        ownership_model="model-gate",
        ownership_generated="generated-gate",
        ownership_speech="speech-gate",
        ownership_output="audio-gate",
        tts_trim="trim",
        turn_planner="planner",
    )
    assert processors.index("input-gate") < processors.index(stt)
    assert processors.index("model-gate") < processors.index(llm)
    assert processors.index(llm) < processors.index("generated-gate") < processors.index("planner")
    assert processors.index("speech-gate") < processors.index(tts)
    assert processors.index(tts) < processors.index("audio-gate") < processors.index("trim")


def test_rtvi_sits_directly_after_transport_input():
    tin, stt, ua, llm, tts, tout, aa = _PROCESSORS
    processors = build_agent_processors(tin, stt, ua, llm, tts, tout, aa, rtvi="rtvi")
    assert processors[:2] == [tin, "rtvi"]
    assert processors[2:] == [stt, ua, llm, tts, tout, aa]


def test_gender_classifier_runs_parallel_to_stt():
    # Both consume InputAudioRawFrames and the LLM turn needs both results, so
    # neither may sit downstream of the other.
    tin, ua, llm, tts, tout, aa = ("tin", "ua", "llm", "tts", "tout", "aa")
    stt, classifier = FrameProcessor(), FrameProcessor()

    processors = build_agent_processors(
        tin, stt, ua, llm, tts, tout, aa, gender_classifier=classifier
    )

    assert processors[0] == tin
    assert isinstance(processors[1], ParallelPipeline)
    assert processors[2:] == [ua, llm, tts, tout, aa]
    # STT must not be reachable in series from the classifier.
    assert stt not in processors


def test_explicit_gender_context_sits_between_stt_and_user_aggregator():
    tin, stt, ua, llm, tts, tout, aa = _PROCESSORS
    processors = build_agent_processors(
        tin,
        stt,
        ua,
        llm,
        tts,
        tout,
        aa,
        caller_gender_context="gender-context",
    )

    assert processors == [tin, stt, "gender-context", ua, llm, tts, tout, aa]


def test_the_idle_nudge_does_not_have_to_cross_the_llm_to_be_heard():
    """Measured live 2026-08-05 06:03 on session b728717f.

    Cerebras accepted a request and sent no token for 21.8s. `_process_context`
    is awaited inline inside `OpenAILLMService.process_frame`, and a processor
    drains its queue one frame at a time, so nothing behind the LLM moved for
    the whole stall.

    The poker sat upstream of it and pushed `TTSSpeakFrame` DOWNSTREAM. That
    frame is a `DataFrame`, so unlike the `SystemFrame`s that reset the poker's
    timer it has no priority path — "caller idle — prompt 1/3" and "2/3" were
    both logged and neither was ever synthesised. The caller heard 24s of
    nothing and hung up.

    So the nudge must reach TTS without passing through the LLM. The frames the
    poker LISTENS for are all SystemFrames and arrive wherever it sits.
    """
    tin, stt, ua, llm, tts, tout, aa = _PROCESSORS
    processors = build_agent_processors(tin, stt, ua, llm, tts, tout, aa, user_idle="idle")

    assert processors.index("idle") > processors.index(llm), (
        "the idle prompt queues behind a stalled LLM and is never heard"
    )
    assert processors.index("idle") < processors.index(tts), (
        "the prompt must still reach TTS to be spoken"
    )
