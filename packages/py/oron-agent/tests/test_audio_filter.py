import pytest
from oron_agent.audio import AudioInFilter, build_audio_in_filter
from pipecat.audio.filters.rnnoise_filter import RNNoiseFilter


async def test_none_builds_no_filter():
    assert await build_audio_in_filter(AudioInFilter.NONE) is None


async def test_rnnoise_builds_an_rnnoise_filter():
    assert isinstance(await build_audio_in_filter(AudioInFilter.RNNOISE), RNNoiseFilter)


async def test_missing_pyrnnoise_raises_instead_of_passing_audio_through(monkeypatch):
    """The upstream filter fails SOFT: it logs and passes audio through unfiltered.
    A bad pin in the image would then look like a healthy deploy that filters nothing."""
    from pipecat.audio.filters import rnnoise_filter

    monkeypatch.setattr(rnnoise_filter, "RNNoise", None)
    with pytest.raises(RuntimeError, match="pyrnnoise"):
        await build_audio_in_filter(AudioInFilter.RNNOISE)


async def test_native_init_failure_raises_from_the_build_not_the_transport(monkeypatch):
    """pyrnnoise imported but init blew up — a native library that failed to load.
    This must surface from build_audio_in_filter, the one place a raise propagates."""
    from pipecat.audio.filters import rnnoise_filter

    def broken_rnnoise(*args, **kwargs):
        raise OSError("native rnnoise library failed to load")

    monkeypatch.setattr(rnnoise_filter, "RNNoise", broken_rnnoise)
    with pytest.raises(RuntimeError, match="failed to initialise"):
        await build_audio_in_filter(AudioInFilter.RNNOISE)


async def test_krisp_without_the_sdk_says_what_to_install(monkeypatch):
    """The SDK is a licensed wheel, not a pip package, so "not installed" is the
    normal state for CI and every developer. It must name the fix, not ImportError."""
    import builtins

    real_import = builtins.__import__

    def no_krisp(name, *args, **kwargs):
        if "krisp" in name:
            raise ImportError("No module named 'krisp_audio'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_krisp)
    with pytest.raises(RuntimeError, match="sdk.krisp.ai"):
        await build_audio_in_filter(
            AudioInFilter.KRISP, krisp_api_key="k", krisp_filter_model_path="/m.kef"
        )


async def test_krisp_without_config_fails_before_it_reaches_the_sdk():
    """A missing key or model must not surface as a Krisp stack trace."""
    with pytest.raises(RuntimeError, match="KRISP_VIVA_API_KEY"):
        await build_audio_in_filter(AudioInFilter.KRISP, krisp_filter_model_path="/m.kef")
    with pytest.raises(RuntimeError, match="KRISP_VIVA_FILTER_MODEL_PATH"):
        await build_audio_in_filter(AudioInFilter.KRISP, krisp_api_key="k")


async def test_krisp_selection_does_not_disturb_the_other_backends():
    """Adding a backend must not change what none/rnnoise resolve to."""
    assert await build_audio_in_filter(AudioInFilter.NONE) is None
    assert isinstance(await build_audio_in_filter(AudioInFilter.RNNOISE), RNNoiseFilter)


async def test_the_probe_starts_prewarms_and_stops(monkeypatch):
    """One test for the whole probe, because it is now one place.

    The build must init the filter itself — a raise inside the transport's own
    start() is swallowed as a non-fatal error, leaving the caller in silence for
    the whole call instead of crashing. The stop() is not tidiness either:
    Krisp's SDK is reference-counted and releases exactly once, so a probe that
    starts without stopping leaks a reference per call.
    """
    calls: list[str | int] = []
    real_start, real_stop, real_filter = (
        RNNoiseFilter.start,
        RNNoiseFilter.stop,
        RNNoiseFilter.filter,
    )

    async def spy_start(self, sample_rate: int) -> None:
        calls.append(sample_rate)
        await real_start(self, sample_rate)

    async def spy_filter(self, audio: bytes) -> bytes:
        calls.append(len(audio))
        return await real_filter(self, audio)

    async def spy_stop(self) -> None:
        calls.append("stop")
        await real_stop(self)

    monkeypatch.setattr(RNNoiseFilter, "start", spy_start)
    monkeypatch.setattr(RNNoiseFilter, "filter", spy_filter)
    monkeypatch.setattr(RNNoiseFilter, "stop", spy_stop)
    await build_audio_in_filter(AudioInFilter.RNNOISE)

    assert calls == [16000, 640, "stop"], (
        "probe at 16k, one 20ms frame to absorb the lazy init, then stop"
    )
