from __future__ import annotations

import io
import re
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "scripts" / "deploy-dev.sh"
EXPECTED = {
    "images.env",
    "infra/caddy/Caddyfile.deployment",
    "infra/compose/deployment.yaml",
    "infra/deployment/systemd/oron-dev-backup.service",
    "infra/deployment/systemd/oron-dev-backup.timer",
    "infra/deployment/systemd/oron-dev.service",
    "scripts/backup-dev.sh",
    "scripts/deploy-dev.sh",
}


def _validator() -> str:
    source = DEPLOY.read_text(encoding="utf-8")
    match = re.search(
        r"python3 - \"\$\{RELEASE_ARCHIVE\}\" \"\$\{STAGING_DIR\}\" <<'PY'\n(.*?)\nPY",
        source,
        re.DOTALL,
    )
    assert match is not None
    return match.group(1)


def _member(name: str, *, kind: bytes = tarfile.REGTYPE, link: str = "") -> tarfile.TarInfo:
    item = tarfile.TarInfo(name)
    item.type = kind
    item.linkname = link
    item.mode = 0o644
    item.size = 1 if kind == tarfile.REGTYPE else 0
    return item


def _archive(path: Path, mutation: str | None = None) -> None:
    names = sorted(EXPECTED)
    if mutation == "missing":
        names.pop()
    with tarfile.open(path, "w:gz") as archive:
        root = tarfile.TarInfo(".")
        root.type = tarfile.DIRTYPE
        root.mode = 0o755
        archive.addfile(root)
        for name in names:
            if mutation in {"symlink", "hardlink"} and name == names[0]:
                kind = tarfile.SYMTYPE if mutation == "symlink" else tarfile.LNKTYPE
                archive.addfile(_member(name, kind=kind, link=names[-1]))
            else:
                archive.addfile(_member(name), io.BytesIO(b"x"))
        if mutation == "duplicate":
            archive.addfile(_member(names[0]), io.BytesIO(b"x"))
        if mutation == "extra":
            archive.addfile(_member("unexpected.txt"), io.BytesIO(b"x"))
        if mutation == "traversal":
            archive.addfile(_member("../escape"), io.BytesIO(b"x"))


def _run_validator(archive: Path, destination: Path) -> subprocess.CompletedProcess[str]:
    destination.mkdir()
    return subprocess.run(  # noqa: S603 - fixed interpreter and local synthetic paths
        [sys.executable, "-", str(archive), str(destination)],
        input=_validator(),
        text=True,
        capture_output=True,
        check=False,
    )


def test_release_validator_extracts_only_the_exact_regular_payload(tmp_path: Path) -> None:
    archive = tmp_path / "release.tar.gz"
    destination = tmp_path / "release"
    _archive(archive)

    result = _run_validator(archive, destination)

    assert result.returncode == 0, result.stderr
    assert {
        str(item.relative_to(destination)).replace("\\", "/")
        for item in destination.rglob("*")
        if item.is_file()
    } == EXPECTED


@pytest.mark.parametrize(
    "mutation",
    ["missing", "extra", "duplicate", "traversal", "symlink", "hardlink"],
)
def test_release_validator_rejects_unsafe_or_incomplete_archives(
    tmp_path: Path, mutation: str
) -> None:
    archive = tmp_path / f"{mutation}.tar.gz"
    destination = tmp_path / mutation
    _archive(archive, mutation)

    result = _run_validator(archive, destination)

    assert result.returncode != 0


def test_ci_preserves_deploy_exit_status_and_binds_archive_checksum() -> None:
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "deployer_sha256=$(sha256sum scripts/deploy-dev.sh" in workflow
    assert 'scripts/deploy-dev.sh "oron-dev:${remote_deployer}"' in workflow
    assert "sha256sum '${remote_deployer}'" in workflow
    assert (
        "sudo bash '${remote_deployer}' '${GITHUB_SHA}' "
        "'${remote_archive}' '${ARCHIVE_SHA256}'" in workflow
    )
    assert "trap 'rm -f ${remote_archive} ${remote_deployer}' EXIT" in workflow
    assert "/opt/oron-dev/scripts/deploy-dev.sh" not in workflow
    assert "deploy-dev.sh '${GITHUB_SHA}' '${remote_archive}'; rm -f" not in workflow


def test_release_images_carry_and_enforce_source_revision() -> None:
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    deploy = DEPLOY.read_text(encoding="utf-8")
    assert workflow.count('--build-arg ORON_SOURCE_REVISION="$GITHUB_SHA"') == 5
    assert "org.opencontainers.image.revision" in deploy
    pull = 'docker pull "${release_images[${key}]}"'
    expected_keys = (
        "for key in WEB_IMAGE CONTROL_API_IMAGE MESSAGING_WORKER_IMAGE "
        "DISPATCHER_IMAGE MIGRATOR_IMAGE"
    )
    assert expected_keys in deploy
    assert pull in deploy
    assert deploy.index(pull) < deploy.index('revision="$(docker image inspect')
    for dockerfile in (
        ROOT / "apps" / "web" / "Dockerfile",
        ROOT / "services" / "py" / "control-api" / "Dockerfile",
        *(ROOT / "infra" / "images").glob("*.Dockerfile"),
    ):
        assert "org.opencontainers.image.revision" in dockerfile.read_text(encoding="utf-8")


def test_deploy_probes_local_edge_without_requiring_public_ip_hairpin() -> None:
    deploy = DEPLOY.read_text(encoding="utf-8")
    assert "PLATFORM_ORIGIN must be an HTTPS origin" in deploy
    assert '--resolve "${PLATFORM_HOST}:443:127.0.0.1"' in deploy
    assert '--resolve "${PLATFORM_HOST}:80:127.0.0.1"' in deploy
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "https://dev.or-on.io/login" in workflow


def test_backup_covers_database_private_objects_and_checksums() -> None:
    backup = (ROOT / "scripts" / "backup-dev.sh").read_text(encoding="utf-8")
    assert "database.dump" in backup
    assert "objects.tar" in backup
    assert "SHA256SUMS" in backup
    assert "*.backup.tar.gz.sha256" in backup


def test_edge_limit_allows_the_largest_content_validated_upload() -> None:
    caddy = (ROOT / "infra" / "caddy" / "Caddyfile.deployment").read_text(encoding="utf-8")
    assert "max_size 22MB" in caddy
