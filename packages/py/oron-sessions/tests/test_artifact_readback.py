from pathlib import Path

import pytest
from oron_sessions.artifacts import ArtifactUnavailable, read_artifact


async def test_local_recording_uri_round_trips_on_the_current_platform(tmp_path: Path) -> None:
    recording = tmp_path / "complete-call.wav"
    recording.write_bytes(b"RIFFfixture-wave")

    assert await read_artifact(recording.as_uri()) == b"RIFFfixture-wave"


async def test_artifact_reader_rejects_non_storage_schemes() -> None:
    with pytest.raises(ArtifactUnavailable, match="cannot read"):
        await read_artifact("https://example.invalid/recording.wav")
