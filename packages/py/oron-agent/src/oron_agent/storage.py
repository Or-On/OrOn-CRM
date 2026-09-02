"""Artifact persistence.

Shape is jpost's: artifacts are written to a local session directory during the
call, then the directory is uploaded at teardown. Local-first means a crash
still leaves partial artifacts on disk, and the upload is one operation at a
known point rather than N in-call round trips.

The backend is behind `ArtifactStore`. A store owns *both* URI construction and
upload, so the scheme written to the session row can never disagree with where
the bytes actually went.
"""

import asyncio
import io
import shutil
import uuid
import wave
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from loguru import logger

# Relative layout, shared by the local staging directory and the remote prefix,
# so a file's local path and its final URI never drift apart. Matches jpost.
RECORDING_PATH = "recordings/merged_audio.wav"
TRANSCRIPT_PATH = "transcripts/transcript.txt"


def session_prefix(session_id: uuid.UUID) -> str:
    return f"conversations/{session_id}"


class ArtifactStore(Protocol):
    """Where a session's artifacts live, and how they get there."""

    def uri(self, session_id: uuid.UUID, relative_path: str) -> str:
        """The address an artifact will have once uploaded. Derived, so it is
        known before the upload runs — and even if it never does."""
        ...

    async def upload_dir(self, session_dir: str, session_id: uuid.UUID) -> bool: ...


class GcsArtifactStore:
    """Google Cloud Storage."""

    scheme = "gs"

    def __init__(self, bucket: str, client=None):
        self._bucket = bucket
        self._client = client

    def uri(self, session_id: uuid.UUID, relative_path: str) -> str:
        return f"{self.scheme}://{self._bucket}/{session_prefix(session_id)}/{relative_path}"

    def _put_dir(self, session_dir: str, session_id: uuid.UUID) -> int:
        # Imported lazily so the agent runs in dev without GCS installed/credentialed.
        from google.cloud import storage

        client = self._client or storage.Client()
        bucket = client.bucket(self._bucket)
        root = Path(session_dir)
        uploaded = 0
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            blob = f"{session_prefix(session_id)}/{path.relative_to(root).as_posix()}"
            bucket.blob(blob).upload_from_filename(str(path))
            uploaded += 1
        return uploaded

    async def upload_dir(self, session_dir: str, session_id: uuid.UUID) -> bool:
        try:
            # The GCS client is synchronous — keep it off the event loop.
            count = await asyncio.to_thread(self._put_dir, session_dir, session_id)
        except Exception:  # noqa: BLE001 - upload remains best-effort at call teardown
            logger.error("Artifact upload failed", session_id=str(session_id))
            return False
        logger.info("Artifacts uploaded", count=count, session_id=str(session_id))
        return True


class LocalArtifactStore:
    """A directory on disk. For dev and tests, where object storage is neither
    available nor wanted; on GKE this would lose artifacts with the pod."""

    scheme = "file"

    def __init__(self, root: str):
        self._root = Path(root)

    def uri(self, session_id: uuid.UUID, relative_path: str) -> str:
        return (self._root / session_prefix(session_id) / relative_path).resolve().as_uri()

    async def upload_dir(self, session_dir: str, session_id: uuid.UUID) -> bool:
        destination = self._root / session_prefix(session_id)
        try:
            await asyncio.to_thread(
                shutil.copytree, session_dir, str(destination), dirs_exist_ok=True
            )
        except Exception:  # noqa: BLE001 - copy remains best-effort at call teardown
            logger.error("Local artifact copy failed", session_id=str(session_id))
            return False
        logger.info("Artifacts copied locally", session_id=str(session_id))
        return True


class ArtifactsBackend(StrEnum):
    GCS = "gcs"
    LOCAL = "local"


def build_artifact_store(backend: ArtifactsBackend, *, bucket: str, local_root: str):
    """Construct the configured store. Called once at the edge and injected —
    nothing downstream reads settings for itself."""
    if backend is ArtifactsBackend.LOCAL:
        return LocalArtifactStore(local_root)
    return GcsArtifactStore(bucket)


async def save_audio_file(audio: bytes, filename: str, sample_rate: int, num_channels: int) -> None:
    """Write raw PCM as a WAV. 16-bit sample width, matching pipecat's output."""
    if not audio:
        logger.warning("Attempted to save empty audio data")
        return
    try:
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        with io.BytesIO() as buffer:
            with wave.open(buffer, "wb") as wf:
                wf.setsampwidth(2)  # 16-bit
                wf.setnchannels(num_channels)
                wf.setframerate(sample_rate)
                wf.writeframes(audio)
            await asyncio.to_thread(Path(filename).write_bytes, buffer.getvalue())
        logger.info("Audio artifact saved")
    except OSError:
        logger.error("Audio artifact could not be saved")
