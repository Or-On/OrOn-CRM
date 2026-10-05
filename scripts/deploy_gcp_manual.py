"""Build and deploy an exact green Main commit to the existing GCP DEV machine.

The default is a read-only plan. --execute publishes images and invokes the
existing backup/drain/rollback deployment procedure. No IAM or provider changes.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "Or-On/OrOn-CRM"
PROJECT = "website-478708"
ZONE = "me-west1-b"
VM = "oron-dev"
SERVICE_ACCOUNT = "oron-github-dev@website-478708.iam.gserviceaccount.com"
REGISTRY = f"me-west1-docker.pkg.dev/{PROJECT}/or-on-platform"
IMAGES = {
    "web": "apps/web/Dockerfile",
    "control-api": "services/py/control-api/Dockerfile",
    "messaging-worker": "infra/images/messaging-worker.Dockerfile",
    "dispatcher": "infra/images/dispatcher.Dockerfile",
    "migrator": "infra/images/migrator.Dockerfile",
}
FILES = (
    "infra/compose/deployment.yaml",
    "infra/caddy/Caddyfile.deployment",
    "infra/deployment/systemd/oron-dev.service",
    "infra/deployment/systemd/oron-dev-backup.service",
    "infra/deployment/systemd/oron-dev-backup.timer",
    "infra/deployment/systemd/oron-dev-recovery.service",
    "infra/deployment/systemd/oron-dev-recovery.timer",
    "scripts/recover_unhealthy.py",
    "db/contracts/schema-manifest.json",
    "scripts/deploy-dev.sh",
    "scripts/backup-dev.sh",
    "scripts/restore-dev-backup.py",
)
JOBS = {
    "TypeScript workspace",
    "Python workspace",
    "PostgreSQL and Alembic",
    "Contract freshness",
    "Architecture and security",
    "Container builds",
}


def exact_sha(value: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{40}", value):
        raise argparse.ArgumentTypeError("A full lowercase 40-character commit is required")
    return value


def github(resource: str) -> dict[str, Any]:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "OrOn-manual-deploy"}
    if token := os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPOSITORY}/{resource}", headers=headers
    )
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
        result = json.load(response)
    if not isinstance(result, dict):
        raise ValueError("Unexpected GitHub response")
    return result


def validate_ci(revision: str, run: dict[str, Any], jobs: list[dict[str, Any]]) -> None:
    expected = {
        "head_sha": revision,
        "head_branch": "main",
        "event": "push",
        "path": ".github/workflows/ci.yml",
        "status": "completed",
        "conclusion": "success",
    }
    if any(run.get(key) != value for key, value in expected.items()):
        raise ValueError("CI must be the successful push run for this exact Main commit")
    if run.get("repository", {}).get("full_name") != REPOSITORY:
        raise ValueError("Unexpected CI repository")
    for name in JOBS:
        matches = [job for job in jobs if job.get("name") == name]
        if len(matches) != 1 or matches[0].get("conclusion") != "success":
            raise ValueError(f"Required CI job is missing or unsuccessful: {name}")


def check_ci(revision: str, run_id: int) -> dict[str, Any]:
    if github("git/ref/heads/main")["object"]["sha"] != revision:
        raise ValueError("Requested revision is no longer the Main tip")
    run = github(f"actions/runs/{run_id}")
    result = github(f"actions/runs/{run_id}/jobs?filter=latest&per_page=100")
    jobs = result["jobs"]
    if result["total_count"] != len(jobs):
        raise ValueError("Incomplete CI jobs response")
    validate_ci(revision, run, jobs)
    return {"run_id": run_id, "url": run["html_url"], "revision": revision, "success": True}


def command(
    arguments: list[str], *, env: dict[str, str] | None = None, log: Path | None = None
) -> str:
    # Arguments are passed directly; credentials are never interpolated into shell commands.
    result = subprocess.run(  # noqa: S603
        arguments, cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8"
    )
    if log:
        log.write_text(result.stdout + result.stderr, encoding="utf-8")
    if result.returncode:
        raise RuntimeError(
            f"{Path(arguments[0]).name} {arguments[1]} failed ({result.returncode}); "
            f"see {log or 'local command diagnostics'}"
        )
    return result.stdout.strip()


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def gcloud_binary() -> str:
    found = shutil.which("gcloud")
    if not found and (local := os.environ.get("LOCALAPPDATA")):
        candidate = Path(local) / "Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd"
        if candidate.is_file():
            found = str(candidate)
    if not found:
        raise RuntimeError("Install Google Cloud CLI and sign in to the existing account")
    return found


def assemble(source: Path, output: Path, images: dict[str, str]) -> Path:
    members = {name: (source / name).read_bytes() for name in FILES}
    members["images.env"] = "".join(
        f"{name.upper().replace('-', '_')}_IMAGE={images[name]}\n" for name in IMAGES
    ).encode()
    archive = output / "release.tar.gz"
    with tarfile.open(archive, "w:gz", format=tarfile.USTAR_FORMAT) as release:
        for name, content in sorted(members.items()):
            item = tarfile.TarInfo(name)
            item.size = len(content)
            item.mode = 0o755 if name.startswith("scripts/") else 0o644
            release.addfile(item, io.BytesIO(content))
    command([sys.executable, str(source / "scripts/check-dev-release.py"), str(archive)])
    return archive


def execute(revision: str, previous: str, run_id: int, receipt: dict[str, Any]) -> Path:
    output = ROOT / ".artifacts/manual-deploy" / f"{revision}-{uuid.uuid4().hex[:8]}"
    output.mkdir(parents=True)
    receipt["verified"] = False
    receipt["phase"] = "building"
    receipt["built_images"] = {}
    receipt["images"] = {}
    journal = output / "receipt.json"

    def checkpoint() -> None:
        journal.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")

    checkpoint()
    source = output / "source"
    source.mkdir()
    source_archive = output / "source.tar"
    command(["git", "archive", "--format=tar", f"--output={source_archive}", revision])
    with tarfile.open(source_archive) as archive:
        archive.extractall(source, filter="data")

    cloud = gcloud_binary()
    env = dict(os.environ)
    env["PATH"] = str(Path(cloud).parent) + os.pathsep + env["PATH"]
    env["CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT"] = SERVICE_ACCOUNT
    auth = output / "docker-config"
    auth.mkdir()
    (auth / "config.json").write_text(
        json.dumps({"credHelpers": {"me-west1-docker.pkg.dev": "gcloud"}}), encoding="utf-8"
    )
    endpoint = json.loads(
        command(["docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"])
    )
    if not endpoint.startswith(("npipe://", "unix://")):
        raise ValueError("Manual deployment requires a local Docker daemon")
    docker = ["docker", "--host", endpoint, "--config", str(auth)]
    images: dict[str, str] = {}
    for name, dockerfile in IMAGES.items():
        print(f"Building exact source: {name}", flush=True)
        tag = f"{REGISTRY}/{name}:{revision}"
        command(
            [
                *docker,
                "build",
                "--progress=plain",
                "--build-arg",
                f"ORON_SOURCE_REVISION={revision}",
                "--file",
                str(source / dockerfile),
                "--tag",
                tag,
                str(source),
            ],
            env=env,
            log=output / f"build-{name}.log",
        )
        metadata = json.loads(command([*docker, "image", "inspect", tag], env=env))[0]
        if (
            metadata["Config"].get("Labels", {}).get("org.opencontainers.image.revision")
            != revision
        ):
            raise ValueError(f"Image source revision mismatch: {name}")
        if (metadata["Os"], metadata["Architecture"]) != ("linux", "amd64"):
            raise ValueError("Expected linux/amd64 deployment image")
        receipt["built_images"][name] = {"image_id": metadata["Id"], "tag": tag}
        checkpoint()
        # Never move an existing commit tag. Registry immutability is checked before push.
        existing = subprocess.run(  # noqa: S603
            [
                cloud,
                "artifacts",
                "docker",
                "images",
                "describe",
                tag,
                f"--project={PROJECT}",
                "--format=value(image_summary.digest)",
                "--quiet",
            ],
            env=env,
            capture_output=True,
            text=True,
        )
        if existing.returncode == 0:
            digest = existing.stdout.strip()
            if digest != metadata.get("Descriptor", {}).get("digest", metadata["Id"]):
                raise ValueError(f"Commit tag already refers to a different image: {name}")
        elif "NOT_FOUND" not in existing.stderr and "not found" not in existing.stderr.lower():
            raise RuntimeError("Registry inspection failed; no image was published")
        command([*docker, "push", tag], env=env, log=output / f"push-{name}.log")
        digest = command(
            [
                cloud,
                "artifacts",
                "docker",
                "images",
                "describe",
                tag,
                f"--project={PROJECT}",
                "--format=value(image_summary.digest)",
                "--quiet",
            ],
            env=env,
        )
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise ValueError("Invalid published image digest")
        immutable = f"{REGISTRY}/{name}@{digest}"
        command([*docker, "pull", immutable], env=env, log=output / f"pull-{name}.log")
        remote = json.loads(command([*docker, "image", "inspect", immutable], env=env))[0]
        if remote["Id"] != metadata["Id"]:
            raise ValueError("Published image differs from the built image")
        images[name] = immutable
        receipt["images"][name] = immutable
        checkpoint()

    archive_path = assemble(source, output, images)
    # Main or CI may have changed during the builds. Recheck before touching the VM.
    receipt["ci"] = check_ci(revision, run_id)
    receipt["images"] = images
    receipt["archive_sha256"] = sha256(archive_path)
    receipt["expected_previous_commit"] = previous
    receipt["phase"] = "transferring"
    checkpoint()
    common = [f"--project={PROJECT}", f"--zone={ZONE}", "--tunnel-through-iap", "--quiet"]
    remote_dir = "/tmp/oron-manual-" + uuid.uuid4().hex  # noqa: S108
    command(
        [
            cloud,
            "compute",
            "ssh",
            VM,
            *common,
            "--command=" + f"umask 077; mkdir {shlex.quote(remote_dir)}",
        ],
        env=env,
    )
    deployer = source / "scripts/deploy-dev.sh"
    verifier = source / "scripts/verify-dev-runtime.sh"
    files = {"release.tar.gz": archive_path, "deploy.sh": deployer, "verify.sh": verifier}
    for name, local_file in files.items():
        command(
            [cloud, "compute", "scp", *common, str(local_file), f"{VM}:{remote_dir}/{name}"],
            env=env,
            log=output / f"transfer-{name}.log",
        )
    lines = ["set -Eeuo pipefail", f"cd {shlex.quote(remote_dir)}"]
    lines.extend(
        f"echo '{sha256(path)}  {name}' | sha256sum --check --status"
        for name, path in files.items()
    )
    lines += [
        f"sudo bash ./deploy.sh {revision} ./release.tar.gz {sha256(archive_path)} {previous}",
        f"sudo bash ./verify.sh {revision}",
        "curl --fail --silent --show-error --max-time 20 https://dev.or-on.io/login >/dev/null",
    ]
    runner = output / "run.sh"
    runner.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    command([cloud, "compute", "scp", *common, str(runner), f"{VM}:{remote_dir}/run.sh"], env=env)
    print("Deploying with backup, call draining and automatic rollback", flush=True)
    receipt["phase"] = "deployment_and_postchecks"
    checkpoint()
    command(
        [
            cloud,
            "compute",
            "ssh",
            VM,
            *common,
            "--command=" + f"bash {shlex.quote(remote_dir + '/run.sh')}",
        ],
        env=env,
        log=output / "deployment.log",
    )
    receipt["verified"] = True
    receipt["phase"] = "verified"
    checkpoint()
    print(f"Deployment and exact runtime verification passed: {journal}", flush=True)
    return journal


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", type=exact_sha, required=True)
    parser.add_argument("--expected-current", type=exact_sha, required=True)
    parser.add_argument("--ci-run-id", type=int, required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if args.ci_run_id <= 0:
        parser.error("--ci-run-id must be positive")
    if command(["git", "rev-parse", args.revision + "^{commit}"]) != args.revision:
        raise ValueError("Revision is not available in the local repository")
    receipt = {
        "ci": check_ci(args.revision, args.ci_run_id),
        "project": PROJECT,
        "zone": ZONE,
        "vm": VM,
        "revision": args.revision,
        "execute": args.execute,
    }
    print(json.dumps(receipt, indent=2), flush=True)
    if args.execute:
        execute(args.revision, args.expected_current, args.ci_run_id, receipt)
    else:
        print("Read-only plan passed. Add --execute to build, publish, deploy and verify.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
