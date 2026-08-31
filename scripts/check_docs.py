"""Validate required Phase 1 documents and local Markdown links."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = (
    "README.md",
    "docs/progress.md",
    "docs/security/threat-model.md",
    "docs/architecture/overview.md",
    "docs/architecture/repository-layout.md",
    "docs/architecture/runtime-topology.md",
    "docs/architecture/technology-baseline.md",
    "docs/architecture/dependency-strategy.md",
    "docs/architecture/database-strategy.md",
    "docs/architecture/contracts.md",
    "docs/architecture/local-development.md",
    "docs/architecture/gcp-dev-target.md",
)
LINK = re.compile(r"(?<!!)\[[^\]]+\]\((?P<target>[^)]+)\)")


def check_documents(root: Path = ROOT) -> list[str]:
    errors = [
        f"missing required document: {relative}"
        for relative in REQUIRED
        if not (root / relative).is_file()
    ]
    markdown = [root / "README.md", *(root / "docs").rglob("*.md")]
    for document in markdown:
        content = document.read_text(encoding="utf-8")
        if content.count("```") % 2:
            errors.append(f"{document.relative_to(root)}: unbalanced fenced code block")
        for match in LINK.finditer(content):
            raw_target = match.group("target").strip().strip("<>").split(maxsplit=1)[0]
            if raw_target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            target = unquote(raw_target).split("#", maxsplit=1)[0]
            if not target:
                continue
            resolved = (document.parent / target).resolve()
            if not resolved.exists():
                errors.append(f"{document.relative_to(root)}: broken link {raw_target}")
    return errors


def main() -> None:
    errors = check_documents()
    if errors:
        print("Documentation validation failed:")
        for error in errors:
            print(f"- {error}")
        raise SystemExit(1)
    print("Required documentation and relative links passed")


if __name__ == "__main__":
    main()
