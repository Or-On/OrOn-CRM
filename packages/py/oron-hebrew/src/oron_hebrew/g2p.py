"""DI factory for renikud_onnx.G2P (RenikudPlus).

PyPI package is `renikud-plus`; the import is `renikud_onnx`. Upstream `G2P()`
can download weights when no path is supplied, so this target adapter never
constructs it without an explicit local path and matching SHA-256. Two
renderings of the same predictions:
  - vocalize()  -> niqqud (injected into Gemini-TTS text; the pronunciation lever)
  - phonemize() -> IPA (used ONLY by gender scoring, never for TTS)
speaker/target_speaker: 0=unknown, 1=male, 2=female.

DI, not singleton: build_g2p() returns a fresh instance; oron-agent builds ONE
and injects it (see plan Global Constraints). session_options caps onnx threads
to the pod's cgroup CPU quota so a CPU-limited pod is not oversubscribed.
"""

from __future__ import annotations

from pathlib import Path

import onnxruntime as ort
from loguru import logger
from renikud_onnx import G2P

from oron_hebrew.assets import ModelAssetError, verify_model_asset


def _cpu_quota() -> int | None:
    """CPU cores this process may use per its cgroup, or None if unlimited/unknown."""
    try:  # cgroup v2: "<quota> <period>" or "max <period>"
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if quota != "max":
            return max(1, round(int(quota) / int(period)))
    except OSError, ValueError:
        pass
    try:  # cgroup v1
        quota = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read_text())
        period = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read_text())
        if quota > 0 and period > 0:
            return max(1, round(quota / period))
    except OSError, ValueError:
        pass
    return None


def _session_options() -> ort.SessionOptions | None:
    cores = _cpu_quota()
    if cores is None:
        return None
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = cores
    opts.inter_op_num_threads = 1
    return opts


def build_g2p(
    model_path: str | None = None,
    *,
    expected_sha256: str | None = None,
) -> G2P | None:
    """Construct one G2P from an immutable local asset without remote fallback."""
    try:
        verified = verify_model_asset(model_path, expected_sha256)
        if verified is None:
            logger.info("renikud G2P disabled; no pinned local model configured")
            return None
        g2p = G2P(str(verified), session_options=_session_options())
        logger.info("renikud G2P loaded (DI instance)")
        return g2p
    except ModelAssetError, OSError, RuntimeError, ValueError:
        logger.warning("renikud G2P unavailable; pinned local model validation/load failed")
        return None


def gender_to_speaker(gender: str | None) -> int:
    """Map a gender string to a RenikudPlus speaker id (0=unknown,1=male,2=female)."""
    if gender == "male":
        return 1
    if gender == "female":
        return 2
    return 0
