import uuid

from oron_agent.storage import (
    RECORDING_PATH,
    TRANSCRIPT_PATH,
    ArtifactsBackend,
    GcsArtifactStore,
    LocalArtifactStore,
    build_artifact_store,
)

SID = uuid.UUID("00000000-0000-4000-8000-000000000abc")


def test_gcs_layout_matches_jpost():
    s = GcsArtifactStore(bucket="oron-prod")
    assert s.uri(SID, RECORDING_PATH) == (
        f"gs://oron-prod/conversations/{SID}/recordings/merged_audio.wav"
    )
    assert s.uri(SID, TRANSCRIPT_PATH) == (
        f"gs://oron-prod/conversations/{SID}/transcripts/transcript.txt"
    )


def test_both_artifacts_share_one_session_prefix():
    """One prefix per session keeps bucket lifecycle rules to a single rule."""
    s = GcsArtifactStore(bucket="b")
    prefix = f"gs://b/conversations/{SID}/"
    assert s.uri(SID, RECORDING_PATH).startswith(prefix)
    assert s.uri(SID, TRANSCRIPT_PATH).startswith(prefix)


def test_local_store_uses_its_own_scheme(tmp_path):
    """The scheme follows the backend — a store cannot claim gs:// while
    writing to disk."""
    root = tmp_path / "artifacts"
    s = LocalArtifactStore(root=str(root))
    expected = (root / "conversations" / str(SID) / TRANSCRIPT_PATH).resolve().as_uri()
    assert s.uri(SID, TRANSCRIPT_PATH) == expected


def test_distinct_sessions_never_collide():
    s = GcsArtifactStore(bucket="b")
    assert s.uri(uuid.uuid4(), TRANSCRIPT_PATH) != s.uri(uuid.uuid4(), TRANSCRIPT_PATH)


def test_backend_selection():
    gcs = build_artifact_store(ArtifactsBackend.GCS, bucket="b", local_root="/tmp/x")
    local = build_artifact_store(ArtifactsBackend.LOCAL, bucket="b", local_root="/tmp/x")
    assert isinstance(gcs, GcsArtifactStore)
    assert isinstance(local, LocalArtifactStore)
    assert gcs.scheme == "gs"
    assert local.scheme == "file"
