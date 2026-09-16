"""Which TTS the agent speaks with.

Soniox by default: ~310ms to first audio against Gemini's ~830ms, measured warm
(connection reused) over 15 Hebrew utterances. Gemini stays selectable so a
voice regression is an env change rather than a rollback.

Voice names are per-vendor namespaces — "Leda" means nothing to Soniox — so the
default voice comes from the provider's own setting.
"""

from collections.abc import Sequence
from typing import Any

# Defined with the flow schema, because a flow now names the vendor it wants and
# oron-flows cannot import this module. Re-exported here so every existing
# caller keeps importing it from the package that builds the service.
from oron_flows import TtsProvider
from pipecat.services.google.tts import GeminiTTSService
from pipecat.services.soniox.tts import SonioxTTSService
from pipecat.services.tts_service import TextAggregationMode, TTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.text.base_text_filter import BaseTextFilter

from oron_agent.tts_clause import FirstClauseAggregator

__all__ = ["TtsProvider", "build_tts", "SonioxUnpointedContextTTSService"]


class SonioxUnpointedContextTTSService(SonioxTTSService):
    """Soniox, with the assistant context kept free of niqqud.

    Soniox returns character timestamps for the words it was SENT — pointed
    Hebrew — and pipecat turns those into the TTSTextFrames the assistant
    aggregator builds its message from. Unpatched, the saved transcript and the
    LLM's memory of its own line come back pointed ("שַׁלוֹם" for "שלום"), and
    every word logs a WordCompletionTracker desync against the LLM's unpointed
    text. Verified live 2026-07-30; Gemini has neither problem because it pushes
    the original, pre-transform text instead.

    Pipecat's timestamp-driven Soniox path produced timestamp text but no audio
    on a real call (the agent channel was sample-for-sample silent). Keep the
    proven path used by earlier audible calls: publish the original text frame
    and do not ask Soniox for character timestamps. This gives up word-level
    interruption progress, but it never feeds pointed text back into the LLM
    and, most importantly, keeps synthesized audio on the transport path.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._push_text_frames = True

    def _build_config_msg(self, context_id: str) -> dict[str, Any]:
        return {
            **super()._build_config_msg(context_id),
            "return_timestamps": False,
            # Soniox documents false as the natural-pacing default. Keep it
            # explicit until call-quality evidence shows that tightening only
            # inter-word pauses improves this voice without sounding rushed.
            "reduce_silence": False,
        }


def build_tts(
    provider: TtsProvider,
    *,
    language: Language,
    voice: str,
    # Passed at construction: TTSService only exposes a private _text_filters,
    # no public setter. Transformers do have add_text_transformer().
    text_filters: Sequence[BaseTextFilter],
    # SENTENCE holds text to a boundary before synthesising; TOKEN speaks as
    # tokens arrive. A supported constructor argument on TTSService, which is
    # what the hand-rolled clause aggregator was reaching past a private
    # attribute to approximate. Its cost is aggregation_p50_ms.
    text_aggregation_mode: TextAggregationMode,
    # Release the turn's OPENING clause without waiting for its sentence.
    # Required, no default: a default is how a caller silently stops passing it.
    first_clause: bool,
    # Rate multiplier, 1.0 being the vendor's own pace. The two spell it
    # differently — Soniox `speed`, Gemini `speaking_rate` — so the name is
    # normalised here rather than leaking a vendor's vocabulary into the flow.
    speed: float,
    soniox_api_key: str,
    soniox_model: str,
    gemini_model: str,
    google_credentials_path: str | None,
) -> TTSService:
    if provider is TtsProvider.SONIOX:
        service: TTSService = SonioxUnpointedContextTTSService(
            api_key=soniox_api_key,
            text_filters=list(text_filters),
            text_aggregation_mode=text_aggregation_mode,
            settings=SonioxTTSService.Settings(
                model=soniox_model, voice=voice, language=language, speed=speed
            ),
        )
    else:
        # Gemini's TTS model takes no rate multiplier — `speaking_rate` belongs to
        # the older Chirp/Journey HTTP service. Pace is directed in words instead,
        # so the same knob becomes a style instruction rather than a number.
        settings = GeminiTTSService.Settings(model=gemini_model, voice=voice, language=language)
        if speed != 1.0:
            settings.prompt = f"Speak at {speed:g}x your normal speaking pace."
        service = GeminiTTSService(
            credentials_path=google_credentials_path,
            location=None,
            text_filters=list(text_filters),
            text_aggregation_mode=text_aggregation_mode,
            settings=settings,
        )
    if first_clause:
        # TTSService builds its aggregator in __init__ and exposes no setter, so
        # this is the only seam. Checked against pipecat 1.7.0 tts_service.py:309.
        # The mode is passed on, or installing this would silently disable it.
        # pyrefly: ignore[bad-assignment]  # the slot's inferred type is the concrete
        # default; the contract it actually calls is BaseTextAggregator.
        service._text_aggregator = FirstClauseAggregator(  # noqa: SLF001
            aggregation_type=text_aggregation_mode
        )
    return service
