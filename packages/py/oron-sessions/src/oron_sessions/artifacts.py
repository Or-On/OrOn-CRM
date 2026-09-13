"""Reading back a call's recording and transcript.

The agent writes artifacts and stores only their URI on the session row, so the
console had a `gs://…` string and no way to open it. Serving the bytes from here
rather than handing the browser a storage URL means the credentials stay
server-side, exactly like the service key behind the admin BFF.

Read-only and URI-driven: the address always comes from the session row, never
from the request, so there is no path for a caller to name a file of its own.
"""

import asyncio
from enum import StrEnum
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname


class ArtifactKind(StrEnum):
    RECORDING = "recording"
    TRANSCRIPT = "transcript"


# What the agent actually writes: a merged WAV and a line-per-turn text file.
CONTENT_TYPE = {
    ArtifactKind.RECORDING: "audio/wav",
    ArtifactKind.TRANSCRIPT: "text/plain; charset=utf-8",
}


class ArtifactUnavailable(Exception):
    """The URI is stored but the bytes cannot be fetched — an upload that never
    landed, a deleted object, or a scheme this deployment cannot read."""


def _read_file(uri: str) -> bytes:
    # file:// URIs store Windows drive paths as /C:/..., which Path interprets
    # as a rooted path on the current drive. url2pathname performs the platform
    # conversion while leaving POSIX paths unchanged.
    path = Path(url2pathname(unquote(urlparse(uri).path)))
    if not path.is_file():
        raise ArtifactUnavailable(f"no artifact at {uri}")
    return path.read_bytes()


def _read_gcs(uri: str) -> bytes:
    # Imported lazily: a deployment on local storage should not need the GCS
    # client installed, and importing it costs a second at startup.
    try:
        from google.cloud import storage
    except ImportError:
        raise ArtifactUnavailable("google-cloud-storage is not installed")

    parsed = urlparse(uri)
    blob = storage.Client().bucket(parsed.netloc).blob(parsed.path.lstrip("/"))
    if not blob.exists():
        raise ArtifactUnavailable(f"no artifact at {uri}")
    return blob.download_as_bytes()


READERS = {"file": _read_file, "gs": _read_gcs}


async def read_artifact(uri: str) -> bytes:
    """Fetch an artifact's bytes. Blocking clients run off the event loop."""
    scheme = urlparse(uri).scheme
    reader = READERS.get(scheme)
    if reader is None:
        raise ArtifactUnavailable(f"cannot read {scheme or 'that'} URIs")
    return await asyncio.to_thread(reader, uri)
