"""What one call consumed, and what that costs.

Usage is a fact about a call and never changes; a price is not. Sessions persist
usage — including which model produced it — and cost is derived on read, so
correcting a rate or switching model re-prices history instead of needing a
backfill.
"""

from datetime import UTC, datetime
from enum import StrEnum
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, PrivateAttr, computed_field

from oron_common.context import CallContext
from oron_common.model_rates import MODEL_RATES


class Carrier(StrEnum):
    """Who carried the PSTN leg. Rates are per carrier *and* number type — on the
    same carrier, Israeli toll-free is 8x local."""

    # Empty so a row written before carrier was recorded reads the same as a call
    # we could not attribute: both price as unpriced rather than as local.
    UNKNOWN = ""
    TELNYX_IL_LOCAL = "telnyx-il-local"
    TELNYX_IL_TOLLFREE = "telnyx-il-tollfree"


def carrier_for(ctx: CallContext) -> Carrier:
    """Keep an unproven PSTN carrier unpriced.

    CallContext.provider identifies the LiveKit transport, not its SIP carrier.
    The DID's country/type, trunk name and untrusted participant metadata cannot
    prove a Telnyx contract. Reviewed outbound account/trunk references remain in
    the admission record, but no authoritative priced carrier binding is supplied
    here yet. Historical explicitly recorded carriers remain priceable on read.
    """
    return Carrier.UNKNOWN


class CallUsage(BaseModel):
    """Per-call consumption.

    `call_seconds` is measured caller-join → caller-leave, not from the session
    row's lifetime: `ended_at` is stamped after recording stops, a settle delay
    and an artifact upload, all of which would otherwise bill as talk time.

    The model names are recorded because they are configurable at runtime, so
    the rate that applies is a property of the call, not of today's config.
    """

    call_seconds: float = 0.0
    # Preserve an explicitly recorded carrier rather than re-derive from an
    # encrypted phone number or today's trunk. Unknown is never assumed Telnyx.
    carrier: str = Carrier.UNKNOWN
    llm_model: str = ""
    llm_prompt_tokens: int = 0
    # A SUBSET of llm_prompt_tokens, not an addition — both Gemini and OpenAI
    # count cache hits inside the prompt total, so `price` subtracts before
    # charging the full rate.
    llm_cached_prompt_tokens: int = 0
    llm_completion_tokens: int = 0
    # Per-model buckets prevent pricing primary usage at a later fallback rate.
    llm_usage_by_model: dict[str, dict[str, int]] = Field(default_factory=dict)
    tts_model: str = ""
    tts_characters: int = 0
    tts_audio_seconds: float = 0.0
    # Client-measured audio actually submitted to STT (pipecat 1.7). Zero means
    # nothing reported it, and `price` falls back to call_seconds — so a row
    # where this is 0 while call_seconds is not says the meter is not running,
    # rather than saying the call was silent.
    stt_audio_seconds: float = 0.0
    # Provider events are process-owned persistence state, never API/model input.
    # Keep them until the checkpoint transaction actually commits.
    _model_events: list[tuple[UUID, int, int, datetime]] = PrivateAttr(default_factory=list)
    _authoritative_model_attempts: bool = PrivateAttr(default=False)

    def enable_model_attempt_accounting(self) -> None:
        self._authoritative_model_attempts = True

    @property
    def has_model_attempt_accounting(self) -> bool:
        return self._authoritative_model_attempts

    def record_model_attempt(self, attempt: dict) -> None:
        """Compatibility API totals include reasoning; do not add it twice.

        Persist missing usage explicitly, including failed billable attempts.
        Detailed audio/cache overlap is never inferred from the prompt total.
        """
        model = attempt["model"]
        bucket = self.llm_usage_by_model.setdefault(
            model, {"prompt": 0, "cached": 0, "completion": 0}
        )
        reported = attempt.get("usage")
        if not isinstance(reported, dict) or any(
            type(reported.get(k)) is not int or reported[k] < 0
            for k in ("prompt_tokens", "completion_tokens")
        ):
            bucket["unknown_attempts"] = bucket.get("unknown_attempts", 0) + 1
            return
        prompt, completion = reported["prompt_tokens"], reported["completion_tokens"]
        detail = reported.get("prompt_tokens_details") or {}
        output_detail = reported.get("completion_tokens_details") or {}
        if not isinstance(detail, dict) or not isinstance(output_detail, dict):
            bucket["unknown_attempts"] = bucket.get("unknown_attempts", 0) + 1
            return
        cached = detail.get("cached_tokens", 0) or 0
        audio = detail.get("audio_tokens", 0) or 0
        reasoning = output_detail.get("reasoning_tokens", 0) or 0
        if (
            any(type(v) is not int or v < 0 for v in (cached, audio, reasoning))
            or max(cached, audio) > prompt
            or reasoning > completion
        ):
            bucket["unknown_attempts"] = bucket.get("unknown_attempts", 0) + 1
            return
        for key, value in (
            ("prompt", prompt),
            ("completion", completion),
            ("cached", cached),
            ("audio", audio),
            ("reasoning", reasoning),
        ):
            bucket[key] = bucket.get(key, 0) + value
        # The API does not always disclose the intersection of audio and cache.
        if audio and cached:
            overlap = detail.get("cached_audio_tokens")
            if type(overlap) is int and 0 <= overlap <= min(audio, cached):
                bucket["cached_audio"] = bucket.get("cached_audio", 0) + overlap
            else:
                bucket["unknown_audio_cache"] = 1
        self.llm_model = model
        self.llm_prompt_tokens += prompt
        self.llm_cached_prompt_tokens += cached
        self.llm_completion_tokens += completion
        self.record_model_event(prompt, completion)

    def record_model_event(self, input_tokens: int, output_tokens: int) -> None:
        if any(
            type(value) is not int or not 0 <= value < 2**63
            for value in (input_tokens, output_tokens)
        ):
            raise ValueError("invalid provider-reported token counts")
        if len(self._model_events) >= 2048:
            raise RuntimeError("voice usage backlog capacity reached")
        self._model_events.append((uuid4(), input_tokens, output_tokens, datetime.now(UTC)))

    def pending_model_events(self) -> tuple[tuple[UUID, int, int, datetime], ...]:
        return tuple(self._model_events)

    def acknowledge_model_events(self, identifiers: set[UUID]) -> None:
        self._model_events = [event for event in self._model_events if event[0] not in identifiers]


class LlmRates(BaseModel):
    prompt_per_1k: float
    completion_per_1k: float
    # Cache hits bill at a discount. Defaults to the full prompt rate so a model
    # priced before anyone checked its cached rate over-reports rather than
    # silently under-bills.
    cached_prompt_per_1k: float | None = None
    audio_prompt_per_1k: float | None = None
    cached_audio_prompt_per_1k: float | None = None

    @property
    def cached_rate(self) -> float:
        return (
            self.prompt_per_1k if self.cached_prompt_per_1k is None else self.cached_prompt_per_1k
        )


class TtsRates(BaseModel):
    """Priced in the units a call can actually be measured in.

    Vendors bill in their own units — Gemini per character and per second of
    audio, Soniox in tokens — but the Soniox TTS API returns no token counts
    (verified on the wire: audio, audio_end, terminated, nothing else), so a
    per-call token figure would be invented. Its published conversions are used
    instead, and each one is applied where it is exact:

    - Output audio tokens are a fixed 30k/hour, so audio seconds ARE the token
      count times a constant. Exact.
    - Input text tokens at "~0.3 per character" are not: the ratio is derived
      from Latin text, and what Soniox receives is pointed Hebrew, whose
      characters roughly double under niqqud. Soniox's own duration figure
      (15k input tokens/hour) avoids the character count entirely, which is why
      `input_text_per_second` exists next to the per-character rate.
    """

    output_audio_per_second: float
    # Gemini's shape: billed on the text sent.
    input_text_per_1k_chars: float = 0.0
    # Soniox's shape: input tokens priced off speech duration, not characters.
    input_text_per_second: float = 0.0


class PriceBook(BaseModel):
    """USD rates per model. See the Obsidian note Telephony/Unit Economics —
    Per-Call Cost Model for every derivation."""

    telephony_per_minute: dict[str, float] = Field(
        default_factory=lambda: {
            # Verified from the Telnyx portal at 0 volume/month — worst case,
            # since their built-in volume discounts only reduce it.
            Carrier.TELNYX_IL_LOCAL.value: 0.005,
            Carrier.TELNYX_IL_TOLLFREE.value: 0.04,
        }
    )
    # Not carrier-keyed, and not model-keyed: Soniox is the only STT and there is
    # no stt_model to key on. Real-time tier, $0.12/hour.
    stt_per_minute: float = 0.12 / 60

    llm: dict[str, LlmRates] = Field(
        default_factory=lambda: {
            **{
                model: LlmRates(
                    prompt_per_1k=rate["inputUsdPerMillion"] / 1000,
                    completion_per_1k=rate["outputUsdPerMillion"] / 1000,
                    cached_prompt_per_1k=rate["cachedInputUsdPerMillion"] / 1000,
                    audio_prompt_per_1k=(
                        rate["audioInputUsdPerMillion"] / 1000
                        if "audioInputUsdPerMillion" in rate
                        else None
                    ),
                    cached_audio_prompt_per_1k=(
                        rate["cachedAudioInputUsdPerMillion"] / 1000
                        if "cachedAudioInputUsdPerMillion" in rate
                        else None
                    ),
                )
                for model, rate in MODEL_RATES.items()
            },
            # Output is the non-thinking "Text Output - Predictions" SKU at
            # $0.60/1M; the flow runs without reasoning, so the $2.50/1M
            # thinking rate does not apply.
            "gemini-2.5-flash": LlmRates(prompt_per_1k=0.0003, completion_per_1k=0.0006),
            "gemini-2.5-pro": LlmRates(prompt_per_1k=0.00125, completion_per_1k=0.010),
            "gemini-2.5-flash-lite": LlmRates(prompt_per_1k=0.0001, completion_per_1k=0.0004),
            # No non-thinking SKU: 3.6 bills reasoning at the response rate.
            "gemini-3.6-flash": LlmRates(
                prompt_per_1k=0.0015, completion_per_1k=0.0075, cached_prompt_per_1k=0.00015
            ),
            # Cerebras, keyed by the id they serve it under. No published cached
            # rate, so prompt hits bill at the full rate rather than a guessed one.
            "gemma-4-31b": LlmRates(prompt_per_1k=0.00099, completion_per_1k=0.00149),
        }
    )
    tts: dict[str, TtsRates] = Field(
        default_factory=lambda: {
            # 25 output audio tokens/sec at $20/1M; input text $1/1M, ~4 chars/token.
            "gemini-3.1-flash-tts-preview": TtsRates(
                output_audio_per_second=0.0005, input_text_per_1k_chars=0.00025
            ),
            "gemini-2.5-flash-tts": TtsRates(
                output_audio_per_second=0.0005, input_text_per_1k_chars=0.00025
            ),
            # Token-billed: 30k output audio tokens/hour at $21.50/1M and 15k
            # input text tokens/hour at $4.00/1M. Both per second of speech —
            # together Soniox's published ~$0.70/hour.
            "tts-rt-v1": TtsRates(
                output_audio_per_second=30_000 / 3600 * 21.50e-6,
                input_text_per_second=15_000 / 3600 * 4.00e-6,
            ),
            "tts-rt-v2": TtsRates(
                output_audio_per_second=30_000 / 3600 * 21.50e-6,
                input_text_per_second=15_000 / 3600 * 4.00e-6,
            ),
        }
    )

    def unpriced_models(self, *, llm: str, tts: str) -> list[str]:
        """Which of the configured models this book cannot price. Switching to a
        model nobody has priced yet is a rate the book is missing, not something
        `price` can infer — so it is worth knowing at startup rather than from a
        month of calls that billed as free."""
        return [m for m, rates in ((llm, self.llm), (tts, self.tts)) if m not in rates]


class CallCost(BaseModel):
    telephony: float = 0.0
    stt: float = 0.0
    llm: float = 0.0
    tts: float = 0.0
    # Models the book had no rate for. Their cost reads 0, which is why this
    # exists: a real spend must not be indistinguishable from a cheap call.
    unpriced: list[str] = Field(default_factory=list)

    @computed_field
    @property
    def total(self) -> float:
        return self.telephony + self.stt + self.llm + self.tts


def price(usage: CallUsage, book: PriceBook) -> CallCost:
    """Cost per component, never just a total — one number cannot say which
    service to attack when a call is expensive.

    TTS bills synthesized audio seconds, not characters: niqqud marks and
    queued-but-unspoken text inflate the character count without adding speech,
    and or-on points every Hebrew utterance.
    """
    minutes = usage.call_seconds / 60
    # STT bills the audio it was actually sent. Falls back to call_seconds when
    # nothing reported it, which over-bills rather than under-bills: silence on
    # the line is still streamed, so the two agree unless input is ever muted.
    stt_seconds = usage.stt_audio_seconds or usage.call_seconds
    cost = CallCost(stt=stt_seconds / 60 * book.stt_per_minute)

    if (rate := book.telephony_per_minute.get(usage.carrier)) is not None:
        cost.telephony = minutes * rate
    elif usage.call_seconds:
        cost.unpriced.append(usage.carrier or "telephony:unknown")

    if usage.llm_usage_by_model:
        for model, tokens in usage.llm_usage_by_model.items():
            if tokens.get("unknown_attempts"):
                cost.unpriced.append(model + ":usage_unknown")
            audio = tokens.get("audio", 0)
            cached_audio = tokens.get("cached_audio", 0)
            model_rate = book.llm.get(model)
            if audio:
                if (
                    tokens.get("unknown_audio_cache")
                    or model_rate is None
                    or model_rate.audio_prompt_per_1k is None
                    or (cached_audio and model_rate.cached_audio_prompt_per_1k is None)
                ):
                    cost.unpriced.append(model + ":audio_unpriced")
                    continue
                cost.llm += (audio - cached_audio) / 1000 * model_rate.audio_prompt_per_1k
                cost.llm += cached_audio / 1000 * (model_rate.cached_audio_prompt_per_1k or 0)
            model_cost = price(
                CallUsage(
                    llm_model=model,
                    llm_prompt_tokens=max(0, tokens.get("prompt", 0) - audio),
                    llm_cached_prompt_tokens=max(0, tokens.get("cached", 0) - cached_audio),
                    llm_completion_tokens=tokens.get("completion", 0),
                ),
                book,
            )
            cost.llm += model_cost.llm
            cost.unpriced.extend(model_cost.unpriced)
    elif llm := book.llm.get(usage.llm_model):
        # Clamped: a provider reporting more cache hits than prompt tokens must not
        # produce a negative charge.
        cached = min(usage.llm_cached_prompt_tokens, usage.llm_prompt_tokens)
        cost.llm = (
            (usage.llm_prompt_tokens - cached) / 1000 * llm.prompt_per_1k
            + cached / 1000 * llm.cached_rate
            + usage.llm_completion_tokens / 1000 * llm.completion_per_1k
        )
    elif usage.llm_prompt_tokens or usage.llm_completion_tokens:
        cost.unpriced.append(usage.llm_model)

    if tts := book.tts.get(usage.tts_model):
        cost.tts = (
            usage.tts_audio_seconds * tts.output_audio_per_second
            + usage.tts_audio_seconds * tts.input_text_per_second
            + usage.tts_characters / 1000 * tts.input_text_per_1k_chars
        )
    elif usage.tts_characters or usage.tts_audio_seconds:
        cost.unpriced.append(usage.tts_model)

    return cost
