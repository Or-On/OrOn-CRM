"""Input-side audio front end: which filter runs on caller audio, if any."""

from enum import StrEnum

from pipecat.audio.filters import rnnoise_filter
from pipecat.audio.filters.base_audio_filter import BaseAudioFilter
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
)
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_start.base_user_turn_start_strategy import (
    BaseUserTurnStartStrategy,
)
from pipecat.turns.user_start.min_words_user_turn_start_strategy import (
    MinWordsUserTurnStartStrategy,
)
from pipecat.turns.user_start.vad_user_turn_start_strategy import VADUserTurnStartStrategy


class AudioInFilter(StrEnum):
    NONE = "none"
    RNNOISE = "rnnoise"
    KRISP = "krisp"


class TurnStart(StrEnum):
    """What may start a user turn — and so what may interrupt the bot.

    Exactly one applies: pipecat's turn controller ignores every trigger after
    the first in a turn, and VAD always fires before a transcript exists, so
    these can never be combined.
    """

    VAD = "vad"  # today's behaviour: ~200ms of audio over the thresholds
    MIN_WORDS = "min_words"  # a transcribed word is required
    RESPONSIVE = "responsive"  # VAD barge-in; transcript start while listening
    KRISP_IP = "krisp_ip"  # Krisp: a real interruption, not a backchannel


class TurnEnd(StrEnum):
    """What decides the caller has finished speaking.

    `vad` is a fixed floor: VAD silence plus a speech timeout that always runs to
    completion. `soniox` hands only the STOP decision to the STT model's Hebrew-
    aware semantic endpointing; the configured start strategy remains local so
    the transcript word gate can still protect against false interruptions.
    """

    VAD = "vad"
    SONIOX = "soniox"


class ResponsiveUserTurnStartStrategy(BaseUserTurnStartStrategy):
    """Cut off bot speech on VAD, but require words while listening.

    A transcription-only start takes roughly one STT partial to stop TTS, which
    made the latest caller talk over the agent for about 650 ms. Pure VAD fixes
    that but lets wordless background noise start turns while the bot is quiet.
    This strategy uses each signal only where it is strongest: VAD for barge-in,
    and transcript evidence for a normal user turn.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._bot_speaking = False

    async def handle_user_turn_started(self):
        self._bot_speaking = False

    async def process_frame(self, frame: Frame) -> ProcessFrameResult:
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
            return ProcessFrameResult.CONTINUE
        if isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
            return ProcessFrameResult.CONTINUE
        if self._bot_speaking and isinstance(frame, VADUserStartedSpeakingFrame):
            await self.trigger_user_turn_started()
            return ProcessFrameResult.STOP
        if (
            isinstance(frame, (TranscriptionFrame, InterimTranscriptionFrame))
            and frame.text.split()
        ):
            await self.trigger_user_turn_started()
            return ProcessFrameResult.STOP
        return ProcessFrameResult.CONTINUE


def build_turn_start_strategy(
    kind: TurnStart, *, min_words: int, krisp_api_key: str = "", krisp_ip_model_path: str = ""
):
    """Resolve the single start strategy. Krisp alone is imported lazily — its
    module raises ImportError at import time when the SDK is absent."""
    if kind is TurnStart.VAD:
        return VADUserTurnStartStrategy()
    if kind is TurnStart.MIN_WORDS:
        return MinWordsUserTurnStartStrategy(min_words=min_words, use_interim=True)
    if kind is TurnStart.RESPONSIVE:
        return ResponsiveUserTurnStartStrategy()
    if not krisp_api_key or not krisp_ip_model_path:
        raise RuntimeError(
            "TURN_START=krisp_ip needs KRISP_VIVA_API_KEY and KRISP_VIVA_IP_MODEL_PATH "
            "(krisp-viva-ip-v1.kef from the Krisp SDK portal)."
        )
    try:
        from pipecat.turns.user_start.krisp_viva_ip_user_turn_start_strategy import (
            KrispVivaIPUserTurnStartStrategy,
        )
    except ImportError as e:
        raise RuntimeError(
            "TURN_START=krisp_ip but the krisp_audio SDK is not installed. It is a wheel "
            "from https://sdk.krisp.ai/, not a package index."
        ) from e
    return KrispVivaIPUserTurnStartStrategy(model_path=krisp_ip_model_path, api_key=krisp_api_key)


def _build_krisp(api_key: str, model_path: str) -> BaseAudioFilter:
    """Krisp VIVA voice isolation (BVC) — the one filter here that removes
    background *speech*, which VAD and STT genuinely cannot.

    Imported lazily on purpose: unlike RNNoise, which degrades to `RNNoise=None`,
    pipecat's Krisp modules raise ImportError at import time when the SDK is
    absent. A module-level import would make this whole module unimportable for
    everyone not carrying the wheel — which today is CI and every developer.
    """
    if not api_key or not model_path:
        raise RuntimeError(
            "AUDIO_IN_FILTER=krisp needs KRISP_VIVA_API_KEY and "
            "KRISP_VIVA_FILTER_MODEL_PATH. The model is a .kef from the Krisp SDK "
            "portal; the key belongs in Secret Manager, never in the image."
        )
    try:
        from pipecat.audio.filters.krisp_viva_filter import KrispVivaFilter
    except ImportError as e:
        raise RuntimeError(
            "AUDIO_IN_FILTER=krisp but the krisp_audio SDK is not installed. It is a "
            "wheel from https://sdk.krisp.ai/, not a package index — install it into "
            "the image with `uv pip install <wheel>`."
        ) from e
    return KrispVivaFilter(api_key=api_key, model_path=model_path)


async def build_audio_in_filter(
    kind: AudioInFilter, *, krisp_api_key: str = "", krisp_filter_model_path: str = ""
) -> BaseAudioFilter | None:
    """Resolve the configured input filter, and prove it initialises here.

    The initialisation must happen where a raise still propagates. Inside the
    transport's `start()` it does not: `FrameProcessor.__process_frame` catches
    it as a non-fatal error, so the transport never finishes starting and the
    caller gets a whole call of silence instead of a crash.
    """
    if kind is AudioInFilter.NONE:
        return None
    # Kept concretely typed: the readiness flag below is RNNoise's, and `kind`
    # does not narrow a BaseAudioFilter.
    rnnoise: rnnoise_filter.RNNoiseFilter | None = None
    if kind is AudioInFilter.KRISP:
        audio_filter = _build_krisp(krisp_api_key, krisp_filter_model_path)
    else:
        if rnnoise_filter.RNNoise is None:
            raise RuntimeError(
                "AUDIO_IN_FILTER=rnnoise but pyrnnoise is not importable — audio would "
                "pass through unfiltered. Install with pipecat-ai[rnnoise] (pins av<17.1.0)."
            )
        rnnoise = rnnoise_filter.RNNoiseFilter()
        audio_filter = rnnoise
    # Probe, then hand back an unstarted filter for the transport to start at the
    # real rate. The stop() is not tidiness: Krisp's SDK is reference-counted and
    # its stop() releases only once, so start-probe + start-by-transport would
    # acquire twice and release once, leaking a reference per call.
    await audio_filter.start(16000)
    if rnnoise is not None:
        if not rnnoise._rnnoise_ready:  # noqa: SLF001
            raise RuntimeError(
                "RNNoise failed to initialise — audio would pass through unfiltered. "
                "Check pyrnnoise and its native library are installed."
            )
        # The ~430ms init is lazy on the first frame and per process, so pushing
        # 20ms of silence here costs the first call only, not every caller.
        await rnnoise.filter(b"\x00" * (16000 // 50 * 2))
    await audio_filter.stop()
    return audio_filter
