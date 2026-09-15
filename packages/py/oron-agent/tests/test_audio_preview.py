"""Installed Pipecat lifecycle with synthetic PCM, never remote provider audio."""

import asyncio
import io
import logging
import wave
from time import monotonic

import pytest
from loguru import logger
from oron_agent.audio_preview import RealPreviewProvider
from oron_agent.config import Settings
from pipecat.frames.frames import TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.services.tts_service import TTSService
from pipecat.transcriptions.language import Language


def settings(enabled=True):
    return Settings(
        _env_file=None,
        ENABLE_REAL_VOICE_PROVIDERS=enabled,
        LIVEKIT_URL="ws://127.0.0.1:7880",
        LIVEKIT_API_KEY="fixture",
        LIVEKIT_API_SECRET="fixture-not-a-secret",
        SONIOX_API_KEY="fixture-soniox",
        GOOGLE_CLOUD_PROJECT="fixture-project",
    )


class FixtureTTS(TTSService):
    def __init__(self):
        super().__init__(sample_rate=24000)
        self.received = []
        self.stopped = False

    async def run_tts(self, text, context_id):
        self.received.append(text)
        yield TTSStartedFrame(context_id=context_id)
        yield TTSAudioRawFrame(b"\0\0" * 240, 24000, 1, context_id=context_id)
        yield TTSStoppedFrame(context_id=context_id)

    async def stop(self, frame):
        self.stopped = True
        await super().stop(frame)


async def test_installed_pipeline_applies_pronunciation_and_returns_bounded_wav():
    fixture = FixtureTTS()
    options = {}

    def factory(provider, **kwargs):
        options.update(kwargs)
        return fixture

    provider = RealPreviewProvider(settings_factory=settings, tts_factory=factory)
    result = await provider.synthesize(
        "חיבור HDMI",
        {
            "schemaVersion": "1.0",
            "language": "he",
            "voiceId": "Harper",
            "speakingPace": 1.1,
            "pronunciationDictionary": [
                {"original": "HDMI", "spoken": "אייץ די אם איי", "language": "he"}
            ],
        },
        confirmed=True,
    )
    assert fixture.received == ["חיבור אייץ די אם איי"]
    assert fixture.stopped and options["voice"] == "Harper" and options["speed"] == 1.1
    assert options["language"] == Language.HE
    assert options["first_clause"] is False
    with wave.open(io.BytesIO(result.audio)) as wav:
        assert (wav.getframerate(), wav.getnchannels(), wav.getnframes()) == (24000, 1, 240)
    assert result.duration_seconds == 0.01 and result.provider == "soniox"
    assert result.canonical_text == "חיבור HDMI"
    assert result.speech_normalized_text == "חיבור אייץ די אם איי"


@pytest.mark.parametrize(
    ("text", "configured_language", "expected_language"),
    [
        ("Could you explain the problem?", "he", Language.EN),
        ("אפשר להסביר מה הבעיה?", "en", Language.HE),
    ],
)
async def test_preview_uses_current_text_language_without_changing_voice(
    text, configured_language, expected_language
):
    fixture = FixtureTTS()
    options = {}

    def factory(provider, **kwargs):
        options.update(kwargs)
        return fixture

    provider = RealPreviewProvider(settings_factory=settings, tts_factory=factory)
    result = await provider.synthesize(
        text,
        {
            "schemaVersion": "1.0",
            "language": configured_language,
            "voiceId": "Harper",
        },
        confirmed=True,
    )

    assert options["language"] == expected_language
    assert options["voice"] == result.voice == "Harper"
    assert result.canonical_text == text


async def test_lowest_boundary_denies_before_provider_construction():
    def forbidden(*args, **kwargs):
        raise AssertionError("provider must not be constructed")

    provider = RealPreviewProvider(settings_factory=lambda: settings(False), tts_factory=forbidden)
    with pytest.raises(PermissionError):
        await provider.synthesize("שלום", {}, confirmed=True)
    with pytest.raises(ValueError):
        await provider.synthesize("שלום", {}, confirmed=False)
    with pytest.raises(ValueError):
        await provider.synthesize("x" * 301, {}, confirmed=True)


async def test_private_provider_errors_redacted_without_hiding_concurrent_logs():
    records = []
    sink = logger.add(lambda message: records.append(str(message)), format="{message} {extra}")
    gate = asyncio.Event()

    def failing(*args, **kwargs):
        try:
            raise RuntimeError("0501234567 secret-token raw submitted text")
        except RuntimeError:
            logger.bind(payload="secret-token").exception("raw submitted text 0501234567")
        raise RuntimeError("provider failed")

    provider = RealPreviewProvider(settings_factory=settings, tts_factory=failing)

    async def unrelated():
        await gate.wait()
        logger.info("unrelated request remains visible")

    other = asyncio.create_task(unrelated())
    try:
        with pytest.raises(RuntimeError):
            await provider.synthesize("raw submitted text", {}, confirmed=True)
        gate.set()
        await other
    finally:
        logger.remove(sink)
    rendered = "".join(records)
    assert "unrelated request remains visible" in rendered
    assert "private audio preview runtime event" in rendered
    for private in ("0501234567", "secret-token", "raw submitted text"):
        assert private not in rendered


async def test_stdlib_sdk_debug_exception_redaction_preserves_other_context(caplog):
    sdk = logging.getLogger("fixture.provider.http")

    def failing(*args, **kwargs):
        try:
            raise ValueError("secret-token 0501234567 raw submitted text")
        except ValueError:
            sdk.exception("request headers %s body %s", "secret-token", "raw submitted text")
            sdk.debug("private %s", "0501234567")
        raise RuntimeError("fixture failure")

    provider = RealPreviewProvider(settings_factory=settings, tts_factory=failing)
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(RuntimeError):
            await provider.synthesize("raw submitted text", {}, confirmed=True)
        sdk.info("unrelated SDK event remains visible")
    assert "unrelated SDK event remains visible" in caplog.text
    assert "private audio preview SDK event" in caplog.text
    for private in ("0501234567", "secret-token", "raw submitted text"):
        assert private not in caplog.text


async def test_existing_loguru_patcher_is_preserved():
    records = []
    previous = logger._core.patcher

    def existing(record):
        record["extra"]["existing_policy"] = "retained"

    logger.configure(patcher=existing)
    sink = logger.add(lambda message: records.append(message.record))
    try:
        RealPreviewProvider(settings_factory=settings)
        logger.info("unrelated")
        assert records[-1]["extra"]["existing_policy"] == "retained"
    finally:
        logger.remove(sink)
        if previous is not None:
            logger.configure(patcher=previous)


async def test_oversize_provider_pcm_fails_closed():
    class OversizeTTS(FixtureTTS):
        async def run_tts(self, text, context_id):
            yield TTSAudioRawFrame(b"\0\0" * 720001, 24000, 1, context_id=context_id)

    fixture = OversizeTTS()
    provider = RealPreviewProvider(
        settings_factory=settings, tts_factory=lambda *args, **kwargs: fixture
    )
    with pytest.raises(RuntimeError, match="synthesis failed"):
        await asyncio.wait_for(provider.synthesize("hello", {}, confirmed=True), timeout=5)


async def test_hung_sdk_after_partial_pcm_is_cancelled_without_audio_or_orphan_tasks():
    entered = asyncio.Event()

    class PartialTTS(FixtureTTS):
        async def run_tts(self, text, context_id):
            yield TTSStartedFrame(context_id=context_id)
            yield TTSAudioRawFrame(b"\0\0" * 240, 24000, 1, context_id=context_id)
            entered.set()
            await asyncio.Event().wait()

    before = asyncio.all_tasks()
    provider = RealPreviewProvider(
        settings_factory=settings, tts_factory=lambda *args, **kwargs: PartialTTS()
    )
    started = monotonic()
    with pytest.raises(TimeoutError):
        async with asyncio.timeout(0.2):
            await provider.synthesize("hello", {}, confirmed=True)
    assert entered.is_set() and monotonic() - started < 3
    await asyncio.sleep(0)
    assert not {task for task in asyncio.all_tasks() - before if not task.done()}
