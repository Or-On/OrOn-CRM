"""Validate the real release archive locally before transferring it to DEV."""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: check-dev-release.py RELEASE_ARCHIVE")
    deployer = Path(__file__).with_name("deploy-dev.sh").read_text(encoding="utf-8")
    validator = re.search(
        r"python3 - \"\$\{RELEASE_ARCHIVE\}\" \"\$\{STAGING_DIR\}\" <<'PY'\n(.*?)\nPY",
        deployer,
        re.DOTALL,
    )
    if validator is None:
        raise SystemExit("Release validator could not be located; refusing transfer")
    archive = Path(sys.argv[1]).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="oron-release-preflight-") as destination:
        result = subprocess.run(  # noqa: S603 - fixed interpreter and owned local paths
            [sys.executable, "-", str(archive), destination],
            input=validator.group(1),
            text=True,
            check=False,
        )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
