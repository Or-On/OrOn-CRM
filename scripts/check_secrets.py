"""Fail on common committed credential forms without inspecting ignored local files."""

from __future__ import annotations

import re
import shutil
import subprocess
from collections.abc import Iterable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    "private key": re.compile("-----BEGIN " + r"(?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    "Google API key": re.compile(r"\bAIza[A-Za-z0-9_-]{35}\b"),
    "Slack token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
}


def scan_paths(root: Path, paths: Iterable[Path]) -> list[str]:
    findings: list[str] = []
    for path in paths:
        relative = path.relative_to(root)
        if relative.name.startswith(".env") and ".example" not in relative.name:
            findings.append(f"{relative}: local environment file is tracked")
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            # ls-files --cached also returns tracked files deleted in the worktree.
            # They have no current content to scan; other read failures still fail.
            continue
        except UnicodeDecodeError:
            continue
        for name, pattern in PATTERNS.items():
            if pattern.search(content):
                findings.append(f"{relative}: possible {name}")
        service_account = '"service_' + 'account"'
        private_key = '"private_' + 'key"'
        if '"type"' in content and service_account in content and private_key in content:
            findings.append(f"{relative}: possible service-account JSON")
    return findings


def tracked_files(root: Path = ROOT) -> list[Path]:
    # The command is fixed, local, read-only, and receives no external arguments.
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("git is required for tracked-file secret scanning")
    completed = subprocess.run(  # noqa: S603
        [git, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    return [root / item.decode() for item in completed.stdout.split(b"\0") if item]


def main() -> None:
    findings = scan_paths(ROOT, tracked_files())
    if findings:
        print("Possible committed secrets:")
        for finding in findings:
            print(f"- {finding}")
        raise SystemExit(1)
    print("Tracked-file secret scan passed")


if __name__ == "__main__":
    main()
