import hashlib

import pytest
from oron_hebrew.assets import ModelAssetError, verify_model_asset


def test_model_asset_is_disabled_without_configuration() -> None:
    assert verify_model_asset(None, None) is None


def test_model_asset_requires_path_and_hash_together(tmp_path) -> None:
    model = tmp_path / "model.onnx"
    model.write_bytes(b"fixture")
    with pytest.raises(ModelAssetError, match="together"):
        verify_model_asset(str(model), None)


def test_model_asset_accepts_only_matching_local_content(tmp_path) -> None:
    model = tmp_path / "model.onnx"
    model.write_bytes(b"fixture")
    digest = hashlib.sha256(b"fixture").hexdigest()
    assert verify_model_asset(str(model), digest) == model.resolve()
    with pytest.raises(ModelAssetError, match="does not match"):
        verify_model_asset(str(model), "0" * 64)
