"""Which TTS the agent speaks with.

Soniox by default: ~310ms to first audio against Gemini's ~830ms, measured warm
(connection reused) over 15 Hebrew utterances. Gemini stays selectable so a
voice regression is an env change rather than a rollback.

Voice names are per-vendor namespaces — "Leda" means nothing to Soniox — so the
default voice comes from the provider's own setting.
"""

import asyncio
import json
from collections.abc import AsyncGenerator, Sequence
from typing import Any

from loguru import logger

# Defined with the flow schema, because a flow now names the vendor it wants and
# oron-flows cannot import this module. Re-exported here so every existing
# caller keeps importing it from the package that builds the service.
from oron_flows import TtsProvider
from pipecat.frames.frames import CancelFrame, ErrorFrame, Frame, TTSStoppedFrame
from pipecat.services.google.tts import GeminiTTSService
from pipecat.services.soniox.tts import SonioxTTSService
from pipecat.services.tts_service import TextAggregationMode, TTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.errors import ErrorCategory
from pipecat.utils.text.base_text_filter import BaseTextFilter
from pipecat.utils.tracing.service_decorators import traced_tts
from websockets.exceptions import ConnectionClosed
from websockets.protocol import State

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

    Re-checked against pipecat 1.11.0 on 2026-09-18: `_build_config_msg` still
    sets `return_timestamps = True` unconditionally, so the override is still
    the only seam. Soniox itself documents `false` as the API default, so this
    asks for the vendor default rather than fighting it. Removing the override
    needs a real LiveKit/SIP call to prove the audio is audible again — the
    failure it guards against was silent audio, which no offline test observes.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._push_text_frames = True
        self._send_lock = asyncio.Lock()
        self._stopping = False
        self._submitted_contexts: set[str] = set()

    async def _connect(self):
        """Defer the setup-time connection until there is text to authenticate it.

        Soniox closes a fresh socket without a stream config after about 10s.
        Keepalives do not authenticate it, and an eagerly configured stream has
        its own shorter text deadline. Neither may span ringing/LLM latency.
        https://soniox.com/docs/tts/rt/connection-keepalive
        """

    async def on_turn_context_created(self, context_id: str):
        """The config must immediately precede real text, not turn creation."""

    async def _fail_pending_audio(self, *, report_error: bool = True):
        pending = self._configured_contexts & self._submitted_contexts
        for context_id in pending:
            if self.audio_context_available(context_id):
                await self.append_to_audio_context(
                    context_id, TTSStoppedFrame(context_id=context_id)
                )
                await self.remove_audio_context(context_id)
        if pending and report_error:
            await self._report_error(
                ErrorFrame(
                    "Soniox connection closed during speech", category=ErrorCategory.CONNECTIVITY
                )
            )
        self._configured_contexts.clear()

    def _log_transport_failure(self, stage: str, error: Exception | None = None) -> None:
        # Close reasons and exception strings can contain provider payloads.
        # Numeric close codes distinguish abrupt loss from a peer close safely.
        received = error.rcvd if isinstance(error, ConnectionClosed) else None
        sent = error.sent if isinstance(error, ConnectionClosed) else None
        logger.warning(
            "Voice synthesis transport failure: provider=soniox stage={} error_type={} "
            "received_close_code={} sent_close_code={} speech_pending={}",
            stage,
            type(error).__name__ if error is not None else "PeerClosed",
            received.code if received else getattr(self._websocket, "close_code", None),
            sent.code if sent else None,
            bool(self._configured_contexts & self._submitted_contexts),
        )

    async def prepare_recovery(self) -> None:
        """Retire the broken stream; only a fresh turn may open another socket.

        Opening an idle socket here would start Soniox's authentication deadline
        before the caller replies. This resets local transport resources, not a
        promise that the provider can synthesize the next turn.
        """
        async with self._send_lock:
            if self._stopping or not self.is_usable:
                raise ConnectionError("Voice synthesis is no longer available")
            await self._retire_socket(report_error=False)

    async def _receive_task_handler(self, report_error):
        # Reconnecting in the background opens another unauthenticated socket
        # and can discard the next turn's audio context. Reconnect on demand.
        try:
            await self._receive_messages()
            if not self._disconnecting and self._configured_contexts & self._submitted_contexts:
                self._log_transport_failure("receive")
        except ConnectionClosed as error:
            self._log_transport_failure("receive", error)
        except Exception as error:
            self._log_transport_failure("receive", error)
            await report_error(ErrorFrame("Soniox audio receive failed"))
        finally:
            if not self._disconnecting:
                if self._websocket:
                    await self._websocket.close()
                await self._fail_pending_audio()

    async def _retire_socket(self, *, report_error: bool = True):
        # Transport reset is recoverable by a NEW context. Only terminal
        # cancel/stop/cleanup sets _stopping; an ambiguous old context remains
        # in _submitted_contexts so that it can never be replayed.
        self._disconnecting = True
        for name in ("_receive_task", "_keepalive_task"):
            task = getattr(self, name)
            if task is not None:
                await self.cancel_task(task)
                setattr(self, name, None)
        await self._fail_pending_audio(report_error=report_error)
        if self._websocket:
            await self._websocket.close()
            await self._call_event_handler("on_disconnected")
        self._websocket = None
        self._partials.clear()

    async def _ensure_socket(self):
        if self._websocket and self._websocket.state is State.OPEN:
            return
        # Do not use _disconnect_websocket here: it removes the active Pipecat
        # audio context, including an unsent new turn waiting for this socket.
        await self._retire_socket()
        await super()._connect()
        if not self._websocket or self._websocket.state is not State.OPEN:
            raise ConnectionError("Soniox connection unavailable")

    @traced_tts
    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None]:
        try:
            async with self._send_lock:
                if self._stopping:
                    return
                # Once text was submitted, reconnection cannot safely replay it:
                # some of its audio may already have reached the caller.
                if context_id in self._submitted_contexts and (
                    context_id not in self._configured_contexts
                    or not self._websocket
                    or self._websocket.state is not State.OPEN
                ):
                    raise ConnectionError("Soniox speech stream was already closed")
                for attempt in range(2):
                    await self._ensure_socket()
                    if self._stopping or not self.audio_context_available(context_id):
                        return
                    try:
                        await self._send_config(context_id)
                        break
                    except ConnectionClosed:
                        # Config contains no speech. One retry is safe only
                        # before any text was attempted on this context.
                        if attempt or context_id in self._submitted_contexts:
                            raise
                if self._stopping or not self.audio_context_available(context_id):
                    await self._close_stream(context_id)
                    return
                self._submitted_contexts.add(context_id)
                await self._get_websocket().send(
                    json.dumps({"text": text, "text_end": False, "stream_id": context_id})
                )
                await self.start_tts_usage_metrics(text)
            yield None
        except Exception as error:
            self._log_transport_failure("send", error)
            # No text replay after an ambiguous send. Keep credentials/provider
            # exception payloads out of downstream error frames and logs.
            async with self._send_lock:
                pending = context_id in self._configured_contexts & self._submitted_contexts
                await self._retire_socket(report_error=False)
                if not pending and self.audio_context_available(context_id):
                    await self.append_to_audio_context(
                        context_id, TTSStoppedFrame(context_id=context_id)
                    )
                    await self.remove_audio_context(context_id)
            # tts_process_generator queues yielded errors behind audio. The
            # context now has an end sentinel, so that path would silently drop
            # this failure after partial audio. Report it out of band instead.
            await self._report_error(
                ErrorFrame(
                    "Soniox speech could not be sent",
                    category=ErrorCategory.CONNECTIVITY
                    if isinstance(error, (ConnectionClosed, ConnectionError, TimeoutError))
                    else ErrorCategory.UNKNOWN,
                )
            )
            yield None

    async def flush_audio(self, context_id: str | None = None):
        async with self._send_lock:
            flush_id = context_id or self.get_active_audio_context_id()
            if (
                not self._stopping
                and flush_id in self._configured_contexts
                and self._websocket
                and self._websocket.state is State.OPEN
            ):
                await super().flush_audio(flush_id)

    async def _disconnect(self):
        # Set before waiting for a connection/send in progress. That operation
        # must not start speech after cancellation requested teardown.
        self._stopping = True
        async with self._send_lock:
            await super()._disconnect()

    async def cancel(self, frame: CancelFrame):
        # Pipecat first awaits its audio producer teardown. Fence new sends
        # before that await, not only when _disconnect eventually runs.
        self._stopping = True
        await super().cancel(frame)

    async def cleanup(self):
        self._stopping = True
        await super().cleanup()

    def _build_config_msg(self, context_id: str) -> dict[str, Any]:
        # Only `return_timestamps` is forced. `reduce_silence` is NOT sent
        # unless a deployment asked for it: Soniox documents `false` as the
        # default, and documents that the field on a model without
        # `supports_silence_reduction` is an `invalid_request` error rather
        # than a no-op. Sending the default explicitly therefore buys nothing
        # and can only ever fail a stream. Pipecat 1.9.0 made it a real
        # setting, omitted while unset, which is what carries it now.
        return {**super()._build_config_msg(context_id), "return_timestamps": False}


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
    # Soniox-only, and sent only when True. It shortens the gaps BETWEEN WORDS
    # (not sentence or punctuation pauses, which is what a robotic-sounding
    # clause boundary actually is), so it is a delivery change with no
    # first-audio benefit. Off until a Hebrew listening comparison says
    # otherwise; Gemini has no equivalent and ignores it.
    reduce_silence: bool,
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
                model=soniox_model,
                voice=voice,
                language=language,
                speed=speed,
                # None, not False: pipecat omits the field entirely while it is
                # None, which is what keeps an unsupported-model error off a
                # setting nobody asked for.
                reduce_silence=True if reduce_silence else None,
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
