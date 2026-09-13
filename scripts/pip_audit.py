"""Run pip-audit with explicit, expiring non-exploitability exceptions."""

from __future__ import annotations

import subprocess
import sys
from datetime import date

EXCEPTIONS = {
    # Pipecat declares NLTK but the platform and Pipecat runtime do not import it.
    # The deployable voice image removes NLTK after dependency installation, and
    # no caller-controlled model path reaches the affected APIs. Upstream still
    # has no patched release as of 2026-09-13. Review within 30 days.
    "PYSEC-2026-3740": date(2026, 10, 13),
}


def active_exceptions(today: date | None = None) -> tuple[str, ...]:
    current = today or date.today()
    expired = sorted(identifier for identifier, expiry in EXCEPTIONS.items() if current > expiry)
    if expired:
        names = ", ".join(expired)
        raise RuntimeError(f"pip-audit security exception expired: {names}")
    return tuple(sorted(EXCEPTIONS))


def main() -> int:
    identifiers = active_exceptions()
    command = [sys.executable, "-m", "pip_audit"]
    for identifier in identifiers:
        command.extend(("--ignore-vuln", identifier))
    print(
        "pip-audit time-bounded exceptions: "
        + ", ".join(f"{identifier} through {EXCEPTIONS[identifier]}" for identifier in identifiers),
        flush=True,
    )
    return subprocess.run(command, check=False).returncode  # noqa: S603


if __name__ == "__main__":
    raise SystemExit(main())
