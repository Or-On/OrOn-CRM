from __future__ import annotations

import base64
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RENDERER = ROOT / "scripts" / "render_deployment_config.ts"
CONFIG_TEMPLATES = ROOT / "infra" / "deployment" / "config"


def _env(path: Path) -> dict[str, str]:
    return dict(
        line.split("=", 1) for line in path.read_text(encoding="utf-8").splitlines() if "=" in line
    )


def test_private_field_and_object_configuration_is_shared_without_printing_secrets(
    tmp_path: Path,
) -> None:
    field_key = base64.b64encode(bytes(range(32))).decode("ascii")
    blind_index_key = base64.b64encode(bytes(reversed(range(32)))).decode("ascii")
    source = tmp_path / "source.env"
    source.write_text(
        "\n".join(
            (
                f"FIELD_CIPHER_LOCAL_KEY={field_key}",
                f"BLIND_INDEX_KEY={blind_index_key}",
            )
        )
        + "\n",
        encoding="utf-8",
    )
    output = tmp_path / "rendered"
    executable = shutil.which("pnpm")
    assert executable is not None

    result = subprocess.run(  # noqa: S603 - repository-owned script and synthetic input
        [
            executable,
            "exec",
            "tsx",
            str(RENDERER),
            "--source",
            str(source),
            "--output",
            str(output),
            "--origin",
            "https://dev.example.test",
            "--database",
            "dev_render_contract",
            "--owner-email",
            "owner@example.test",
            "--tenant-name",
            "Synthetic deployment tenant",
            "--tenant-slug",
            "synthetic-deployment",
            "--tls-email",
            "tls@example.test",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    emitted = result.stdout + result.stderr
    assert field_key not in emitted
    assert blind_index_key not in emitted
    services = {
        name: _env(output / "config" / f"{name}.env")
        for name in ("web", "messaging-worker", "dispatcher")
    }
    for config in services.values():
        assert config["FIELD_CIPHER_LOCAL_KEY"] == field_key
        assert config["BLIND_INDEX_KEY"] == blind_index_key
        assert config["ARTIFACTS_BACKEND"] == "local"
        assert config["ARTIFACTS_LOCAL_ROOT"] == "/var/lib/oron/objects"


def test_manual_deployment_templates_keep_private_object_configuration_in_sync() -> None:
    required = {
        "FIELD_CIPHER_LOCAL_KEY",
        "BLIND_INDEX_KEY",
        "ARTIFACTS_BACKEND",
        "ARTIFACTS_LOCAL_ROOT",
    }
    for service in ("web", "messaging-worker", "dispatcher"):
        config = _env(CONFIG_TEMPLATES / f"{service}.env.template")
        assert required <= config.keys()
        assert config["ARTIFACTS_BACKEND"] == "local"
        assert config["ARTIFACTS_LOCAL_ROOT"] == "/var/lib/oron/objects"
