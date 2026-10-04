from __future__ import annotations

import base64
import json
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
    additional_accounts = json.dumps(
        [
            {
                "key": "fictional",
                "phoneNumberId": "22990011",
                "wabaId": "88110022",
                "graphApiVersion": "v23.0",
                "accessToken": "fixture-token",
                "appSecret": "fictional-app-secret",
                "webhookVerifyToken": "fictional-verify-token",
            }
        ],
        separators=(",", ":"),
    )
    source = tmp_path / "source.env"
    source.write_text(
        "\n".join(
            (
                f"FIELD_CIPHER_LOCAL_KEY={field_key}",
                f"BLIND_INDEX_KEY={blind_index_key}",
                f"WHATSAPP_ADDITIONAL_ACCOUNTS_JSON={additional_accounts}",
                "WHATSAPP_MEMORY_SIGNATURE_PROOF_ENABLED=true",
                "WHATSAPP_MEMORY_VERIFIER_DATABASE_URL=postgresql://synthetic-verifier:private-verifier@db/dev_render_contract",
            )
        )
        + "\n",
        encoding="utf-8",
    )
    output = tmp_path / "rendered"
    # Exercise the cached repository renderer directly. The package-manager
    # launcher may try an unavailable registry version switch; this is not an
    # install or a signature-policy bypass.
    executable = shutil.which("node")
    assert executable is not None

    result = subprocess.run(  # noqa: S603 - repository-owned script and synthetic input
        [
            executable,
            str(ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"),
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
    assert "fixture-token" not in emitted
    services = {
        name: _env(output / "config" / f"{name}.env")
        for name in ("web", "messaging-worker", "dispatcher")
    }
    for config in services.values():
        assert config["FIELD_CIPHER_LOCAL_KEY"] == field_key
        assert config["BLIND_INDEX_KEY"] == blind_index_key
        assert config["ARTIFACTS_BACKEND"] == "local"
        assert config["ARTIFACTS_LOCAL_ROOT"] == "/var/lib/oron/objects"
    for service in ("web", "messaging-worker"):
        assert services[service]["WHATSAPP_ADDITIONAL_ACCOUNTS_JSON"] == additional_accounts

    sweeper = _env(output / "config" / "sweeper.env")
    assert sweeper["DATABASE_URL"] == services["dispatcher"]["VOICE_DATABASE_URL"]

    verifier = "postgresql://synthetic-verifier:private-verifier@db/dev_render_contract"
    assert services["web"]["WHATSAPP_MEMORY_VERIFIER_DATABASE_URL"] == verifier
    assert services["web"]["WHATSAPP_MEMORY_SIGNATURE_PROOF_ENABLED"] == "true"
    assert verifier not in emitted
    for name in (
        "messaging-worker",
        "dispatcher",
        "control-api",
        "sweeper",
        "migrator",
        "bootstrap-owner",
    ):
        config = _env(output / "config" / f"{name}.env")
        assert "WHATSAPP_MEMORY_VERIFIER_DATABASE_URL" not in config
        assert "WHATSAPP_MEMORY_SIGNATURE_PROOF_ENABLED" not in config


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


def test_nonweb_compose_overrides_cannot_inherit_signature_verifier_secrets() -> None:
    import re

    document = (ROOT / "infra/compose/deployment.yaml").read_text(encoding="utf-8")
    for service in (
        "messaging-worker",
        "control-api",
        "dispatcher",
        "sweeper",
        "migrator",
        "bootstrap-owner",
    ):
        block = re.search(
            r"^  " + re.escape(service) + r":\n(.*?)(?=^  \S|\Z)", document, re.M | re.S
        )
        assert block is not None
        assert 'WHATSAPP_MEMORY_VERIFIER_DATABASE_URL: ""' in block.group(1)
        assert 'WHATSAPP_MEMORY_SIGNATURE_PROOF_ENABLED: "false"' in block.group(1)
    web = re.search(r"^  web:\n(.*?)(?=^  \S|\Z)", document, re.M | re.S)
    assert web is not None and "web.env" in web.group(1)
    assert "WHATSAPP_MEMORY_VERIFIER_DATABASE_URL" not in web.group(1)
