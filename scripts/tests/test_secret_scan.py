from __future__ import annotations

from pathlib import Path

from scripts.check_secrets import scan_paths


def test_detects_private_key_material(tmp_path: Path) -> None:
    candidate = tmp_path / "credential.txt"
    candidate.write_text(
        "-----BEGIN " + "PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
        encoding="utf-8",
    )

    assert "possible private key" in scan_paths(tmp_path, [candidate])[0]


def test_allows_empty_example_secret_variables(tmp_path: Path) -> None:
    example = tmp_path / ".env.example"
    example.write_text("LLM_API_KEY=\n", encoding="utf-8")

    assert scan_paths(tmp_path, [example]) == []


def test_deleted_worktree_file_does_not_prevent_scanning_remaining_files(tmp_path: Path) -> None:
    candidate = tmp_path / "credential.txt"
    candidate.write_text("-----BEGIN " + "PRIVATE KEY-----", encoding="utf-8")
    findings = scan_paths(tmp_path, [tmp_path / "deleted.tsx", candidate])
    assert len(findings) == 1
    assert "possible private key" in findings[0]


def test_missing_tracked_environment_is_still_reported(tmp_path: Path) -> None:
    findings = scan_paths(tmp_path, [tmp_path / ".env"])
    assert findings == [".env: local environment file is tracked"]
