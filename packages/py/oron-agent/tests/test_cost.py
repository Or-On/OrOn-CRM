import uuid

import pytest
from oron_agent.cost import UsageObserver
from oron_common import (
    CallContext,
    CallUsage,
    Carrier,
    Direction,
    LlmRates,
    PriceBook,
    TtsRates,
    carrier_for,
    price,
)
from pipecat.frames.frames import (
    MetricsFrame,
    TTSAudioRawFrame,
)
from pipecat.metrics.metrics import (
    LLMTokenUsage,
    LLMUsageMetricsData,
    STTUsage,
    STTUsageMetricsData,
    TTSUsageMetricsData,
)

TENANT_ID = uuid.UUID("00000000-0000-0000-0000-0000000000aa")

FLOW_ID = uuid.uuid4()

FLASH = "gemini-2.5-flash"
TTS = "gemini-3.1-flash-tts-preview"


def _pushed(frame, timestamp=0):
    return type("FramePushed", (), {"frame": frame, "timestamp": timestamp})()


_MS = 1_000_000


def _metrics(*data):
    return MetricsFrame(data=list(data))


def _stt(seconds):
    return STTUsageMetricsData(
        processor="stt", model="soniox", value=STTUsage(audio_seconds=seconds)
    )


def _llm(prompt, completion):
    return LLMUsageMetricsData(
        processor="llm",
        model="gemini-2.5-flash",
        value=LLMTokenUsage(
            prompt_tokens=prompt,
            completion_tokens=completion,
            total_tokens=prompt + completion,
        ),
    )


async def test_llm_tokens_accumulate_across_turns():
    usage = CallUsage()
    obs = UsageObserver(usage)
    await obs.on_push_frame(_pushed(_metrics(_llm(100, 20))))
    await obs.on_push_frame(_pushed(_metrics(_llm(150, 30))))

    assert usage.llm_prompt_tokens == 250
    assert usage.llm_completion_tokens == 50


async def test_tts_characters_accumulate():
    usage = CallUsage()
    obs = UsageObserver(usage)
    for n in (12, 30):
        await obs.on_push_frame(
            _pushed(_metrics(TTSUsageMetricsData(processor="tts", model="g", value=n)))
        )
    assert usage.tts_characters == 42


async def test_tts_audio_seconds_come_from_the_pcm_itself():
    usage = CallUsage()
    obs = UsageObserver(usage)
    one_second = b"\x00" * (8000 * 1 * 2)  # 8 kHz mono 16-bit
    await obs.on_push_frame(
        _pushed(TTSAudioRawFrame(audio=one_second, sample_rate=8000, num_channels=1))
    )
    assert usage.tts_audio_seconds == pytest.approx(1.0)


async def test_the_same_audio_frame_seen_twice_is_counted_once():
    """Pipecat pushes one frame across several processor links, so the observer
    sees it repeatedly; counting each sighting inflates audio cost silently."""
    usage = CallUsage()
    obs = UsageObserver(usage)
    frame = TTSAudioRawFrame(audio=b"\x00" * 16000, sample_rate=8000, num_channels=1)
    await obs.on_push_frame(_pushed(frame))
    await obs.on_push_frame(_pushed(frame))

    assert usage.tts_audio_seconds == pytest.approx(1.0)


async def test_the_same_metrics_frame_seen_twice_is_counted_once():
    """A MetricsFrame crosses every link downstream of the service that emitted
    it, so counting each sighting made the sessions columns exact multiples of
    the truth — LLM ×8, TTS characters ×7, STT seconds ×11 on the deployed
    stack, the factor being nothing but pipeline position."""
    usage = CallUsage()
    obs = UsageObserver(usage)
    frame = _metrics(
        _llm(100, 20),
        _stt(3.0),
        TTSUsageMetricsData(processor="tts", model="g", value=42),
    )
    for _ in range(8):
        await obs.on_push_frame(_pushed(frame))

    assert usage.llm_prompt_tokens == 100
    assert usage.llm_completion_tokens == 20
    assert usage.stt_audio_seconds == pytest.approx(3.0)
    assert usage.tts_characters == 42


async def test_a_recycled_memory_address_does_not_erase_a_later_frame():
    """Deduping on `id(frame)` undercounts badly: CPython hands the address of a
    released frame to the next one, so a genuinely new frame looks 'already
    seen'. TTS frames are released as they drain and audio is the dominant cost
    — a 200-frame loop lost 45% of its seconds before this was pinned."""
    usage = CallUsage()
    obs = UsageObserver(usage)
    for _ in range(200):
        frame = TTSAudioRawFrame(audio=b"\x00" * 16000, sample_rate=8000, num_channels=1)
        await obs.on_push_frame(_pushed(frame))
        del frame

    assert usage.tts_audio_seconds == pytest.approx(200.0)


async def test_an_unrelated_frame_changes_nothing():
    usage = CallUsage()
    await UsageObserver(usage).on_push_frame(_pushed(object()))
    assert usage == CallUsage()


def test_price_sums_every_component():
    book = PriceBook(
        telephony_per_minute={Carrier.TELNYX_IL_LOCAL: 0.005},
        stt_per_minute=0.0033,
        llm={FLASH: LlmRates(prompt_per_1k=0.0003, completion_per_1k=0.0025)},
        tts={TTS: TtsRates(output_audio_per_second=0.0, input_text_per_1k_chars=0.006)},
    )
    usage = CallUsage(
        call_seconds=120,  # 2 min telephony + STT
        carrier=Carrier.TELNYX_IL_LOCAL,
        llm_model=FLASH,
        llm_prompt_tokens=1000,
        llm_completion_tokens=1000,
        tts_model=TTS,
        tts_characters=1000,
        tts_audio_seconds=0,
    )
    cost = price(usage, book)

    assert cost.telephony == pytest.approx(0.010)
    assert cost.stt == pytest.approx(0.0066)
    assert cost.llm == pytest.approx(0.0028)
    assert cost.tts == pytest.approx(0.006)
    assert cost.total == pytest.approx(0.0254)


def test_an_empty_call_costs_nothing():
    cost = price(CallUsage(), PriceBook())
    assert cost.total == 0.0
    # No usage means no model ran, so a blank model name is not an unpriced one.
    assert cost.unpriced == []


def test_cost_is_reported_per_component_not_just_a_total():
    """A single number cannot answer 'why is this call expensive' — the whole
    point of the breakdown is knowing which service to attack."""
    usage = CallUsage(call_seconds=60, llm_model=FLASH, llm_prompt_tokens=5000, tts_characters=500)
    cost = price(usage, PriceBook())
    assert set(cost.model_dump()) >= {"telephony", "stt", "llm", "tts", "total"}


def test_tts_is_priced_on_audio_seconds_not_characters():
    """Characters are decoupled from speech: niqqud marks inflate the count
    without adding a syllable, and queued-but-unspoken text is counted too. or-on
    points every Hebrew utterance, so a per-character rate over-bills by design."""
    book = PriceBook()
    # Same speech, wildly different character counts after niqqud.
    plain = CallUsage(tts_model=TTS, tts_characters=1000, tts_audio_seconds=60)
    pointed = CallUsage(tts_model=TTS, tts_characters=1800, tts_audio_seconds=60)

    assert price(plain, book).tts == pytest.approx(price(pointed, book).tts, rel=0.35)
    # Audio dominates; characters are the minor input-token term.
    assert price(plain, book).tts == pytest.approx(60 * 0.0005 + 1.0 * 0.00025)


def test_soniox_prices_at_its_published_hourly_rate():
    """Soniox bills tokens and its API reports none, so both terms are modelled
    from duration. The check that this is honest is the vendor's own headline:
    an hour of generated speech is ~$0.70. Characters must not move it — the
    text Soniox tokenizes is the pointed text, which nothing here counts."""
    book = PriceBook()
    an_hour = CallUsage(tts_model="tts-rt-v1", tts_audio_seconds=3600, tts_characters=0)
    with_text = an_hour.model_copy(update={"tts_characters": 50_000})

    assert price(an_hour, book).tts == pytest.approx(0.70, abs=0.01)
    assert price(with_text, book).tts == price(an_hour, book).tts


def test_default_rates_are_the_verified_published_prices():
    """Zero defaults made an unpriced component read as free; these are the rates
    confirmed for the services or-on actually runs."""
    book = PriceBook()
    assert book.telephony_per_minute[Carrier.TELNYX_IL_LOCAL] == 0.005
    assert book.telephony_per_minute[Carrier.TELNYX_IL_TOLLFREE] == 0.04  # 8x local
    assert book.stt_per_minute == pytest.approx(0.002)  # Soniox $0.12/hr
    assert book.llm[FLASH].prompt_per_1k == 0.0003  # Gemini 2.5 Flash in
    assert book.llm[FLASH].completion_per_1k == 0.0006  # non-thinking output SKU
    assert book.tts[TTS].output_audio_per_second == 0.0005


def test_the_models_or_on_actually_runs_are_in_the_book():
    """The defaults in oron_agent.config must be priceable out of the box, or the
    first real call reports itself as unpriced."""
    from oron_agent.config import Settings

    defaults = Settings.model_fields
    book = PriceBook()
    assert defaults["vertex_llm_model"].default in book.llm
    # Both providers are selectable per call, so both must be priceable.
    assert defaults["soniox_tts_model"].default in book.tts
    assert defaults["gemini_tts_model"].default in book.tts


def test_every_model_deploy_env_offers_is_priced():
    """The defaults are not the only reachable models — deploy.env.example hands an
    operator a model id to paste, and the book is keyed by the id the provider
    serves. A typo on either side bills the call at $0, which is the one outcome
    `unpriced` exists to prevent. `gemma-4-31b` was read back off Cerebras's own
    /v1/models before it was priced; this keeps the two spellings tied together.
    """
    pytest.skip("target voice deployment environment is tracked by P5-011")


def test_a_real_shaped_call_prices_sanely():
    """3-minute call: telephony must not dominate — the AI does."""
    usage = CallUsage(
        call_seconds=180,
        llm_model=FLASH,
        llm_prompt_tokens=6000,
        llm_completion_tokens=900,
        tts_model=TTS,
        tts_characters=1500,
        tts_audio_seconds=95,
    )
    cost = price(usage, PriceBook())
    assert cost.telephony < cost.llm + cost.tts + cost.stt
    assert 0.0 < cost.total < 0.25


async def test_the_model_that_actually_ran_is_recorded_not_the_configured_one():
    """VERTEX_LLM_MODEL and GEMINI_TTS_MODEL are env-configurable, so config says
    what was requested; the metrics frame says what billed."""
    usage = CallUsage()
    obs = UsageObserver(usage)
    await obs.on_push_frame(
        _pushed(
            _metrics(
                LLMUsageMetricsData(
                    processor="llm",
                    model="gemini-2.5-pro",
                    value=LLMTokenUsage(prompt_tokens=10, completion_tokens=5, total_tokens=15),
                ),
                TTSUsageMetricsData(processor="tts", model="some-tts-v9", value=100),
            )
        )
    )
    assert usage.llm_model == "gemini-2.5-pro"
    assert usage.tts_model == "some-tts-v9"


def test_switching_model_changes_the_price():
    """The whole point: a pricier model must cost more for identical usage."""
    book = PriceBook()
    flash = CallUsage(llm_model="gemini-2.5-flash", llm_prompt_tokens=1_000_000)
    pro = CallUsage(llm_model="gemini-2.5-pro", llm_prompt_tokens=1_000_000)

    assert price(pro, book).llm > price(flash, book).llm


def test_an_unknown_model_is_flagged_never_silently_free():
    """Pricing an unrecognised model at zero would report a real spend as free
    and look identical to a genuinely cheap call."""
    cost = price(CallUsage(llm_model="whatever-3", llm_prompt_tokens=5000), PriceBook())
    assert "whatever-3" in cost.unpriced
    assert cost.llm == 0.0


def test_a_known_model_leaves_nothing_unpriced():
    usage = CallUsage(
        llm_model="gemini-2.5-flash",
        tts_model="gemini-3.1-flash-tts-preview",
        carrier=Carrier.TELNYX_IL_LOCAL,
        llm_prompt_tokens=100,
        tts_audio_seconds=10,
        call_seconds=60,
    )
    assert price(usage, PriceBook()).unpriced == []


def test_switching_carrier_changes_the_telephony_price():
    """Same staleness bug as the models: a flat per-minute rate silently becomes
    wrong when the carrier changes, and history cannot be re-priced without
    knowing who carried the call. Toll-free is 8x local on the same carrier."""
    book = PriceBook()
    local = CallUsage(call_seconds=600, carrier=Carrier.TELNYX_IL_LOCAL)
    tollfree = CallUsage(call_seconds=600, carrier=Carrier.TELNYX_IL_TOLLFREE)

    assert price(tollfree, book).telephony > price(local, book).telephony


def test_an_unknown_carrier_is_flagged_never_silently_free():
    cost = price(CallUsage(call_seconds=600, carrier="some-carrier"), PriceBook())
    assert "some-carrier" in cost.unpriced
    assert cost.telephony == 0.0
    # STT bills on audio minutes regardless of who carried them.
    assert cost.stt > 0.0


def _inbound(to_number):
    return CallContext(
        call_id="c",
        direction=Direction.INBOUND,
        to_number=to_number,
        flow_id=FLOW_ID,
        tenant_id=TENANT_ID,
    )


def test_the_dialed_number_says_which_rate_applies():
    """Toll-free is 8x local, and the dialed DID is the only thing that says which
    one was called."""
    assert carrier_for(_inbound("+9721800600600")) is Carrier.TELNYX_IL_TOLLFREE
    assert carrier_for(_inbound("+97236774000")) is Carrier.TELNYX_IL_LOCAL


@pytest.mark.parametrize(
    "ctx",
    [
        CallContext(
            call_id="c",
            direction=Direction.OUTBOUND,
            to_number="+9721800600600",
            flow_id=FLOW_ID,
            tenant_id=TENANT_ID,
        ),
        CallContext(call_id="c", direction=Direction.INBOUND, flow_id=FLOW_ID, tenant_id=TENANT_ID),
        _inbound("sip:anonymous@example.com"),
        # A console test carries a perfectly parseable Israeli number and still
        # has no PSTN leg to bill — there is no carrier in the path at all.
        CallContext(
            call_id="c",
            direction=Direction.BROWSER,
            to_number="+97236774000",
            flow_id=FLOW_ID,
            tenant_id=TENANT_ID,
        ),
    ],
    ids=[
        "outbound-bills-by-destination",
        "no-dialed-number",
        "not-a-phone-number",
        "browser-has-no-pstn-leg",
    ],
)
def test_an_unattributable_leg_is_unknown_not_assumed_local(ctx):
    assert carrier_for(ctx) is Carrier.UNKNOWN
    assert price(CallUsage(call_seconds=600, carrier=carrier_for(ctx)), PriceBook()).telephony == 0


def test_a_model_switch_is_caught_at_startup_not_after_a_month_of_free_calls():
    """Moving to a model nobody has priced is a missing rate, not something price()
    can infer — so the agent asks the book up front."""
    book = PriceBook()
    # Not a real model name — naming a future one is what rotted this test before.
    unpriced = "unpriced-model"
    assert book.unpriced_models(llm=FLASH, tts=TTS) == []
    assert book.unpriced_models(llm=unpriced, tts=TTS) == [unpriced]
    # And the cost it would have reported meanwhile: zero, flagged.
    cost = price(CallUsage(llm_model=unpriced, llm_prompt_tokens=10_000), book)
    assert cost.llm == 0.0
    assert cost.unpriced == [unpriced]


def test_stt_is_not_carrier_keyed_because_only_one_vendor_transcribes():
    """Soniox is the only STT and CallUsage has no stt_model to key on — a dict
    here would have no key to populate. Keyed when that changes, not before."""
    assert PriceBook().stt_per_minute == pytest.approx(0.002)


def test_history_reprices_when_the_book_changes_not_the_row():
    """Rows keep usage plus the model name, so correcting a rate re-prices old
    calls with no backfill — which is why cost is not stored."""
    usage = CallUsage(llm_model="gemini-2.5-flash", llm_completion_tokens=1000)
    cheap = price(usage, PriceBook())
    dearer = PriceBook()
    dearer.llm["gemini-2.5-flash"].completion_per_1k *= 2

    assert price(usage, dearer).llm == pytest.approx(cheap.llm * 2)


def _llm_cached(prompt, cached, completion, model="gemini-3.6-flash"):
    return LLMUsageMetricsData(
        processor="llm",
        model=model,
        value=LLMTokenUsage(
            prompt_tokens=prompt,
            completion_tokens=completion,
            total_tokens=prompt + completion,
            cache_read_input_tokens=cached,
        ),
    )


async def test_cache_hits_are_captured_not_silently_folded_into_the_prompt_total():
    """Without this the discount is invisible: the tokens still bill at full rate."""
    usage = CallUsage()
    obs = UsageObserver(usage)
    await obs.on_push_frame(_pushed(_metrics(_llm_cached(1000, 800, 50))))
    await obs.on_push_frame(_pushed(_metrics(_llm_cached(1200, 900, 60))))

    assert usage.llm_prompt_tokens == 2200
    assert usage.llm_cached_prompt_tokens == 1700


def test_cached_tokens_are_a_subset_of_the_prompt_and_bill_at_the_discount():
    """Both Gemini and OpenAI count cache hits inside prompt_tokens, so charging
    both totals in full would double-bill the cached ones."""
    book = PriceBook()
    rates = book.llm["gemini-3.6-flash"]
    usage = CallUsage(
        llm_model="gemini-3.6-flash", llm_prompt_tokens=1000, llm_cached_prompt_tokens=800
    )

    cost = price(usage, book)
    expected = 200 / 1000 * rates.prompt_per_1k + 800 / 1000 * rates.cached_prompt_per_1k
    assert cost.llm == pytest.approx(expected)

    # ...and it is genuinely cheaper than the same call with no cache hits.
    uncached = price(CallUsage(llm_model="gemini-3.6-flash", llm_prompt_tokens=1000), book)
    assert cost.llm < uncached.llm


def test_a_model_with_no_cached_rate_bills_cache_hits_at_the_full_rate():
    """Over-report rather than under-bill: an unchecked model must not invent a discount."""
    book = PriceBook()
    assert book.llm[FLASH].cached_prompt_per_1k is None
    cached = price(
        CallUsage(llm_model=FLASH, llm_prompt_tokens=1000, llm_cached_prompt_tokens=900), book
    )
    plain = price(CallUsage(llm_model=FLASH, llm_prompt_tokens=1000), book)
    assert cached.llm == pytest.approx(plain.llm)


def test_more_cache_hits_than_prompt_tokens_cannot_produce_a_credit():
    """A provider miscounting must not bill us a negative number."""
    book = PriceBook()
    cost = price(
        CallUsage(
            llm_model="gemini-3.6-flash", llm_prompt_tokens=100, llm_cached_prompt_tokens=5000
        ),
        book,
    )
    assert cost.llm >= 0


def test_token_and_character_metrics_are_actually_enabled():
    """UsageObserver can only count what pipecat emits, and LLM/TTS usage sits
    behind a *second* flag that defaults to False. Shipped with only
    enable_metrics, a real call recorded 41.4s of TTS audio and 31.6s of
    duration while every token and character count read zero — the observer was
    never the problem.
    """
    from oron_agent.bot import pipeline_params

    params = pipeline_params()

    assert params.enable_metrics is True
    assert params.enable_usage_metrics is True


async def test_stt_seconds_accumulate_from_the_service_not_the_call_clock():
    """Reported incrementally since the last report, so the observer adds rather
    than replaces — taking the last report would bill one interval per call."""
    usage = CallUsage()
    obs = UsageObserver(usage)

    await obs.on_push_frame(_pushed(_metrics(_stt(12.0))))
    await obs.on_push_frame(_pushed(_metrics(_stt(8.0))))

    assert usage.stt_audio_seconds == pytest.approx(20.0)


def test_stt_bills_the_audio_it_was_sent_when_the_service_reports_it():
    usage = CallUsage(call_seconds=600, stt_audio_seconds=120)
    assert price(usage, PriceBook()).stt == pytest.approx(120 / 60 * PriceBook().stt_per_minute)


def test_stt_falls_back_to_the_call_clock_when_nothing_reports():
    """Every row written before pipecat 1.7 has 0 here, and an STT service that
    reports nothing must not make a call look free."""
    usage = CallUsage(call_seconds=600)
    assert usage.stt_audio_seconds == 0.0
    assert price(usage, PriceBook()).stt == pytest.approx(600 / 60 * PriceBook().stt_per_minute)
