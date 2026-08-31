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
    example.write_text("AI_API_KEY=\n", encoding="utf-8")

    assert scan_paths(tmp_path, [example]) == []
