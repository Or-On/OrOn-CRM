import uuid
import wave
from pathlib import Path

from oron_agent.artifacts import SessionDir
from oron_agent.storage import (
    RECORDING_PATH,
    TRANSCRIPT_PATH,
    GcsArtifactStore,
    LocalArtifactStore,
    save_audio_file,
)
from oron_agent.transcript import TranscriptHandler, TranscriptMessage

SID = uuid.UUID("00000000-0000-4000-8000-000000000abc")


def test_local_tree_mirrors_the_remote_layout(tmp_path):
    """Local path and final URI must not drift — the upload is a straight copy."""
    d = SessionDir(SID, root=str(tmp_path))
    store = GcsArtifactStore(bucket="b")
    assert Path(d.recording).as_posix().endswith(RECORDING_PATH)
    assert Path(d.transcript).as_posix().endswith(TRANSCRIPT_PATH)
    assert store.uri(SID, RECORDING_PATH).endswith(RECORDING_PATH)
    assert store.uri(SID, TRANSCRIPT_PATH).endswith(TRANSCRIPT_PATH)


def test_session_dir_creates_parents(tmp_path):
    d = SessionDir(SID, root=str(tmp_path))
    assert Path(d.recording).parent.is_dir()
    assert Path(d.transcript).parent.is_dir()


async def test_transcript_appends_turns_in_order(tmp_path):
    out = tmp_path / "transcript.txt"
    h = TranscriptHandler(output_file=str(out))
    await h.save_message(TranscriptMessage(role="user", content="שלום", timestamp="t1"))
    await h.save_message(TranscriptMessage(role="assistant", content="היי", timestamp="t2"))
    assert out.read_text(encoding="utf-8") == "[t1] user: שלום\n[t2] assistant: היי\n"


async def test_transcript_written_incrementally(tmp_path):
    """Each turn hits disk as it happens, so a crashed call still leaves what
    was said up to that point."""
    out = tmp_path / "transcript.txt"
    h = TranscriptHandler(output_file=str(out))
    await h.save_message(TranscriptMessage(role="user", content="one"))
    assert out.read_text().strip() == "user: one"  # present before the call ends


async def test_transcript_write_failure_does_not_raise(tmp_path):
    # Unwritable path — a transcript failure must never take the call down.
    h = TranscriptHandler(output_file=str(tmp_path / "nope" / "deep" / "t.txt"))
    await h.save_message(TranscriptMessage(role="user", content="x"))


async def test_save_audio_writes_a_readable_wav(tmp_path):
    path = tmp_path / "recordings" / "merged_audio.wav"
    pcm = b"\x00\x01" * 8000
    await save_audio_file(pcm, str(path), sample_rate=16000, num_channels=1)
    with wave.open(str(path), "rb") as wf:
        assert wf.getframerate() == 16000
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        assert wf.readframes(wf.getnframes()) == pcm


async def test_save_audio_writes_stereo_with_channels_interleaved(tmp_path):
    """The recording is stereo — caller left, agent right (pipecat's
    `merge_audio_buffers` interleaving). Evals read the caller channel alone, so
    a regression back to mixed mono has to fail here."""
    path = tmp_path / "recordings" / "merged_audio.wav"
    # One frame of (left=1, right=2), twice.
    pcm = b"\x01\x00\x02\x00" * 2
    await save_audio_file(pcm, str(path), sample_rate=16000, num_channels=2)
    with wave.open(str(path), "rb") as wf:
        assert wf.getnchannels() == 2
        assert wf.getnframes() == 2  # 4 samples across 2 channels
        assert wf.readframes(wf.getnframes()) == pcm


async def test_save_audio_skips_empty(tmp_path):
    path = tmp_path / "empty.wav"
    await save_audio_file(b"", str(path), sample_rate=16000, num_channels=1)
    assert not path.exists()


class FakeBlob:
    def __init__(self, store, name):
        self._store, self._name = store, name

    def upload_from_filename(self, path):
        self._store[self._name] = Path(path).read_bytes()


class FakeBucketClient:
    """Minimal stand-in for google.cloud.storage.Client."""

    def __init__(self):
        self.uploaded: dict[str, bytes] = {}
        self.bucket_names: list[str] = []

    def bucket(self, name):
        self.bucket_names.append(name)
        return self

    def blob(self, name):
        return FakeBlob(self.uploaded, name)


async def test_upload_mirrors_tree_under_session_prefix(tmp_path, monkeypatch):
    """Exercises the real _upload_dir so the blob naming is actually covered."""
    d = SessionDir(SID, root=str(tmp_path))
    Path(d.transcript).write_text("hello")
    Path(d.recording).write_bytes(b"audio")

    fake = FakeBucketClient()
    store = GcsArtifactStore(bucket="my-bucket", client=fake)

    assert await store.upload_dir(str(d.path), SID) is True
    assert fake.bucket_names == ["my-bucket"]
    assert fake.uploaded[f"conversations/{SID}/{TRANSCRIPT_PATH}"] == b"hello"
    assert fake.uploaded[f"conversations/{SID}/{RECORDING_PATH}"] == b"audio"


async def test_upload_failure_is_best_effort(tmp_path):
    """An upload failure logs and returns False — it must not end the call."""

    class ExplodingClient:
        def bucket(self, name):
            raise RuntimeError("gcs down")

    store = GcsArtifactStore(bucket="b", client=ExplodingClient())
    assert await store.upload_dir(str(tmp_path), SID) is False


async def test_local_store_copies_the_tree(tmp_path):
    """The local backend is a real backend, not a stub — artifacts land on disk."""
    d = SessionDir(SID, root=str(tmp_path / "staging"))
    Path(d.transcript).write_text("hello")
    Path(d.recording).write_bytes(b"audio")

    store = LocalArtifactStore(root=str(tmp_path / "store"))
    assert await store.upload_dir(str(d.path), SID) is True

    dest = tmp_path / "store" / "conversations" / str(SID)
    assert (dest / TRANSCRIPT_PATH).read_text() == "hello"
    assert (dest / RECORDING_PATH).read_bytes() == b"audio"
