from pipecat.pipeline.parallel_pipeline import ParallelPipeline


def build_agent_processors(
    transport_in,
    stt,
    user_agg,
    llm,
    tts,
    transport_out,
    assistant_agg,
    *,
    gender_classifier=None,
    caller_gender_context=None,
    turn_planner=None,
    evidence_context=None,
    evidence_gate=None,
    recognition=None,
    audio_buffer=None,
    tts_trim=None,
    user_idle=None,
    bot_speaking=None,
    hold_opener=None,
    rtvi=None,
    ownership_input=None,
    ownership_recognition=None,
    ownership_model=None,
    ownership_generated=None,
    ownership_speech=None,
    ownership_output=None,
) -> list:
    """Ordered pipeline: input -> {gender classifier || STT} -> user ctx -> LLM
    -> TTS -> output -> assistant ctx -> [audio buffer].

    The gender classifier and STT are PARALLEL branches: both consume the same
    InputAudioRawFrames, and the LLM turn needs both results (the transcript to
    answer, the caller's gender to answer in the right Hebrew forms). Neither
    depends on the other, so neither should wait for the other.

    ParallelPipeline dedupes by frame id, so the audio frames that pass through
    the gender branch do not reach the aggregator twice — STT's transcripts and
    one copy of each audio frame flow on.

    The audio buffer goes last so it sees both sides of the conversation after
    the transport has emitted them (same placement as jpost).

    `tts_trim` sits between TTS and the transport, dropping each response's
    silent head before it is played out.

    Evidence is refreshed before inference; full-turn validation precedes TTS.
    """
    listen = ParallelPipeline([gender_classifier], [stt]) if gender_classifier is not None else stt
    processors = [transport_in]
    if ownership_input is not None:
        processors.append(ownership_input)
    # Immediately after input, before STT and before the gender branch: the hold
    # works by dropping caller audio, and anything placed after a consumer would
    # let that consumer start a turn the hold then has to unwind.
    if hold_opener is not None:
        processors.append(hold_opener)
    # Upstream of everything, so the console sees a turn begin rather than its
    # conclusion.
    if rtvi is not None:
        processors.append(rtvi)
    processors.append(listen)
    if recognition is not None:
        processors.append(recognition)
    if ownership_recognition is not None:
        processors.append(ownership_recognition)
    # Explicit self-identification in the transcript must become authoritative
    # context before the user aggregator emits the LLM frame for that same turn.
    if caller_gender_context is not None:
        processors.append(caller_gender_context)
    processors.append(user_agg)
    if evidence_context is not None:
        processors.append(evidence_context)
    if ownership_model is not None:
        processors.append(ownership_model)
    processors.append(llm)
    if ownership_generated is not None:
        processors.append(ownership_generated)
    # Text filters run after TTS aggregation and cannot repair a clause that was
    # already sent. The planner emits one AggregatedTextFrame for the complete,
    # bounded LLM turn, bypassing the comma fast path.
    if turn_planner is not None:
        processors.append(turn_planner)
    if evidence_gate is not None:
        processors.append(evidence_gate)
    # BETWEEN the LLM and TTS, not before both. Its prompt is a TTSSpeakFrame — a
    # DataFrame, so it waits in the queue of every processor ahead of it — and
    # `OpenAILLMService.process_frame` awaits the completion inline. A provider
    # that accepts a request and sends no token therefore silences the one thing
    # meant to rescue the call: 2026-08-05 06:03, 21.8s with no token, two
    # prompts logged, neither synthesised, caller hung up on 24s of dead air.
    # What the poker LISTENS for — user/bot speaking — are SystemFrames, which
    # take the priority path and reach it wherever it sits.
    if user_idle is not None:
        processors.append(user_idle)
    if ownership_speech is not None:
        processors.append(ownership_speech)
    processors.append(tts)
    if ownership_output is not None:
        processors.append(ownership_output)
    # Before the transport — the only place dropping silence shortens the wait.
    if tts_trim is not None:
        processors.append(tts_trim)
    processors.append(transport_out)
    # After the output, where BotStarted/StoppedSpeakingFrame are emitted — the
    # input-side gender classifier reads this to reject the bot's own echo.
    if bot_speaking is not None:
        processors.append(bot_speaking)
    processors.append(assistant_agg)
    if audio_buffer is not None:
        processors.append(audio_buffer)
    return processors
