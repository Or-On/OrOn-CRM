"""Local-only voice-model asset verification.

Model files are operational assets, not package data. They are accepted only
from an explicit local path whose content matches an immutable SHA-256. This
module never downloads or resolves a remote model identifier.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

_SHA256 = re.compile(r"[0-9a-f]{64}")


class ModelAssetError(ValueError):
    """A configured model asset is absent, unsafe, or not the pinned content."""


def _asset_digest(path: Path) -> str:
    digest = hashlib.sha256()
    files = [path] if path.is_file() else sorted(item for item in path.rglob("*") if item.is_file())
    if not files:
        raise ModelAssetError("model asset contains no files")
    for item in files:
        if item.is_symlink():
            raise ModelAssetError("model asset may not contain symbolic links")
        if path.is_dir():
            digest.update(item.relative_to(path).as_posix().encode("utf-8"))
            digest.update(b"\0")
        with item.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def verify_model_asset(path_value: str | None, expected_sha256: str | None) -> Path | None:
    """Return a verified local asset, or ``None`` when the capability is disabled."""

    if path_value is None and expected_sha256 is None:
        return None
    if not path_value or not expected_sha256:
        raise ModelAssetError("model path and SHA-256 must be configured together")
    normalized_sha = expected_sha256.strip().lower()
    if _SHA256.fullmatch(normalized_sha) is None:
        raise ModelAssetError("model SHA-256 must be 64 lowercase hexadecimal characters")
    path = Path(path_value).expanduser().resolve(strict=True)
    if path.is_symlink():
        raise ModelAssetError("model asset may not be a symbolic link")
    if _asset_digest(path) != normalized_sha:
        raise ModelAssetError("model asset SHA-256 does not match the configured pin")
    return path
