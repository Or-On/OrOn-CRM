from __future__ import annotations

from pathlib import Path

from scripts.check_docs import check_documents


def test_reports_broken_relative_link(tmp_path: Path) -> None:
    for relative in (
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
    ):
        document = tmp_path / relative
        document.parent.mkdir(parents=True, exist_ok=True)
        document.write_text("# Test\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("[missing](docs/missing.md)\n", encoding="utf-8")

    assert "broken link docs/missing.md" in check_documents(tmp_path)[0]
