# Release and backup safety review

Date: 2026-09-12. Changes are in repository-controlled deployment tooling only.
No cloud request, backup upload, deployment, systemd enable/start, or real provider
operation occurred. The user's running platform and its database were untouched.

## Bounded corrections

- `infra/scripts/release.py` rejects remote or alternate `DOCKER_HOST` and active
  Docker contexts before Compose can run. Every Compose invocation also pins
  `--host unix:///var/run/docker.sock` and removes context overrides, preventing an
  active-context change from redirecting later writes. This deliberately accepts
  only the reviewed Linux root Docker daemon, not rootless/Docker Desktop/SSH/TCP.
- Configuration paths must be absolute, non-symlink, current-user-owned and mode
  0700; configuration files must be regular, same-owner and 0600. The persistent
  data directory must still be a separate mount, never the boot/root filesystem.
- Backups must use a private 0700 direct child of that mounted data directory.
  Archives, checksums and release records use exclusive 0600 creation. Dumps and
  checksums are flushed before success. An incomplete dump has no checksum and is
  never uploaded by this command; local partial files are retained for explicit
  operator review rather than silently deleted.
- Backup upload uses the same nonblocking private host lock as deployment and
  recovery. A scheduled backup cannot overlap a release managed by these scripts.
  Lock files reject symlinks, unsafe permissions and unexpected ownership.
- GCS upload uses atomic `--if-generation-match=0`, not `--no-clobber` (which may
  issue a preliminary object GET). This matches the VM's create-only object role;
  restore readers remain separate. Archive and checksum have separate uploads:
  failure of either retains local files and fails the operation; a partial remote
  pair is not a verified backup.
- Upload stdout/stderr and gcloud HTTP/file logging are suppressed, and each
  upload has a 600-second timeout. The systemd unit has a private StateDirectory
  for gcloud configuration outside the home directory hidden by `ProtectHome`.
  It remains disabled until explicit deployment authority and operator review.
- Host helpers parse under Python 3.12, compatible with the selected Ubuntu LTS
  and Debian VM baselines. Scoped Ruff targets stop introducing Python 3.14-only
  syntax into `/usr/bin/python3` deployment commands.

## Verification evidence

- `uv run pytest -q infra/tests scripts/tests/test_staging_secrets.py
  -p no:cacheprovider`: **77 passed**. Includes existing release/restore tests,
  remote-Docker rejection, pinned local target, private-path refusal, exclusive
  writes, partial dump behavior, dry-run isolation, upload failure/timeout,
  create-only upload arguments and release-lock ordering. All upload/Docker
  subprocesses in unit tests are mocked; these do not prove GCS connectivity.
- Focused Ruff check/format passed for the changed release, backup, secret helper
  and test files.
- `infra/tests/release_posix_check.py` passed in an already-built disposable Linux
  container with network disabled, read-only root, dropped capabilities, two
  read-only source mounts and temporary tmpfs only. It exercised actual Linux
  0700/0600 permissions, symlink refusal and conflicting/reusable `flock`. Dump and
  mount checks were modeled; no PostgreSQL or Docker socket was available inside.
- Python `ast.parse(feature_version=(3,12))` checks all four host-side deployment
  helpers. This is syntax compatibility, not a real Ubuntu/Debian host execution.

## Explicit residuals

Actual VM bootstrap, mounted-disk ownership, service unit operation, GCS IAM and
conditional uploads, scheduled timer execution, alert delivery, retention policy,
and full authorized cloud restore remain **PENDING LIVE STAGING VALIDATION**.
No cloud RPO/RTO or successful remote backup is claimed. Operators must monitor
timer failures and missing archive/checksum pairs; no failure-alert destination
has been provisioned. Local retention is manual; this tooling never purges data.

A checksum detects accidental corruption, not tampering by someone who can
replace both files. Restore only a trusted, independently reviewed backup into a
new quarantined database; pg_restore can execute SQL supplied by its source.
Schema-compatible rollback is an explicit operator assertion, not automatically
proved. Restore never selects the live database or switches services to it.

The local Docker socket and deployment root user are privileged. These guards
prevent wrong-target accidents, not a malicious root operator or compromised
Docker daemon. No unattended billing/provider replay is enabled by the release.

References: [Docker context behavior](https://docs.docker.com/engine/manage-resources/contexts/)
and [gcloud storage cp preconditions](https://docs.cloud.google.com/sdk/gcloud/reference/storage/cp).
