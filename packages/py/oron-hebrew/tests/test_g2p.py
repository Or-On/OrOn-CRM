import hashlib

from oron_hebrew.g2p import build_g2p, gender_to_speaker


class _FakeG2P:
    def __init__(self, model_path: str, *, session_options=None) -> None:
        self.model_path = model_path
        self.session_options = session_options

    def vocalize(self, text: str, **_kwargs) -> str:
        return f"pointed:{text}"

    def phonemize(self, text: str) -> str:
        return f"ˈ{text}"


def test_gender_to_speaker_mapping() -> None:
    assert gender_to_speaker("male") == 1
    assert gender_to_speaker("female") == 2
    assert gender_to_speaker(None) == 0
    assert gender_to_speaker("unknown") == 0


def test_build_g2p_never_downloads_without_a_pinned_local_asset(monkeypatch) -> None:
    monkeypatch.setattr(
        "oron_hebrew.g2p.G2P",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("loader called")),
    )
    assert build_g2p() is None


def test_build_g2p_uses_verified_local_assets_and_is_not_a_singleton(tmp_path, monkeypatch) -> None:
    model = tmp_path / "renikud.onnx"
    model.write_bytes(b"fixture-model")
    digest = hashlib.sha256(b"fixture-model").hexdigest()
    monkeypatch.setattr("oron_hebrew.g2p.G2P", _FakeG2P)

    first = build_g2p(str(model), expected_sha256=digest)
    second = build_g2p(str(model), expected_sha256=digest)

    assert isinstance(first, _FakeG2P)
    assert isinstance(second, _FakeG2P)
    assert first is not second
    assert first.vocalize("שלום") == "pointed:שלום"
    assert "ˈ" in first.phonemize("שלום")
