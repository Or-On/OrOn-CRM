# Private staging secret retrieval

Implemented 2026-09-12. **No GCP access or real secret retrieval was performed.**
Terraform creates secret metadata and secret-specific VM access only. Payloads
and versions are supplied separately by an authorized operator, never Terraform,
Git, build arguments, image layers, or workflow logs.

## Contract

`infra/scripts/staging_secrets.py` reads a non-secret reference manifest containing
an exact project ID, five fixed output filenames, exact allowlisted secret IDs,
and pinned positive numeric versions. `latest`, aliases, arbitrary output names,
path traversal, duplicate/invalid environment keys and executable environment
overrides are refused. Payloads are bounded to 64 KiB each and decoded as UTF-8.
Provider `ENABLE_*` settings must remain `false` in restricted staging.

Each secret contains a **complete service-specific raw env file**, not one value:

| Output | Payload owner / intended contents |
| --- | --- |
| `web.env` | Web DB runtime role and auth material; only approved web settings |
| `control-api.env` | API DB runtime role and service-auth material |
| `messaging-worker.env` | Worker DB runtime role; real-provider settings disabled |
| `migrator.env` | Migration-only DSN; never shared with web/worker |
| `postgres-password.txt` | PostgreSQL initialization password, single line |

Compose `format: raw` preserves `$` in password hashes without interpolation.
Do not source these files in a shell. DSN credentials must agree with the
separately reviewed role-bootstrap operation; this helper neither creates roles
nor changes database passwords. Full service config validation runs at startup.

## Reviewed manual procedure (not executed)

1. Approve the dedicated project, VM identity, exact secret IDs and secret
   versions. Supply versions through the authorized Secret Manager workflow.
   Each service gets only its required values; never copy a developer `.env`.
2. Configure Terraform `secret_ids` with the five metadata names (the example
   matches `infra/scripts/staging-secrets.example.json`). Per-secret IAM grants
   runtime VM `secretAccessor`, not deploy CI and not project-wide access.
3. On the Linux VM, create a private operator-owned configuration parent, e.g.
   `/srv/or-on-platform/private-config` with mode `0700`. No parent symlinks.
   Install the official gcloud CLI. Use the attached VM identity, not downloaded
   service-account keys or an administrator's interactive login.
4. Copy/edit the **reference-only** manifest to pin actual numeric versions.
   First run without `--execute` to validate references without cloud access:

```sh
python infra/scripts/staging_secrets.py \
  --manifest /srv/or-on-platform/reviewed-secret-references.json \
  --project YOUR_REVIEWED_STAGING_PROJECT \
  --allow-secret oron-staging-web-env \
  --allow-secret oron-staging-control-api-env \
  --allow-secret oron-staging-messaging-worker-env \
  --allow-secret oron-staging-migrator-env \
  --allow-secret oron-staging-postgres-password \
  --output-dir /srv/or-on-platform/private-config/release-REVIEWED_ID
```

5. With separate authorization to retrieve, repeat adding `--execute`. Execution
   is POSIX-only. A new `0700` temporary directory receives pre-created `0600`
   files using `gcloud secrets versions access NUMBER --project=EXACT
   --secret=EXACT --out-file=PRIVATE_PATH`. stdout/stderr and HTTP/file logging are
   disabled. No secret bytes become process arguments or user-visible errors.
6. Only after all files validate is the directory renamed to the new release
   destination. Existing releases are never overwritten. Set `STAGING_CONFIG_DIR`
   to that completed directory and run the separately approved release procedure.
   This helper does **not** start/restart services, perform migrations, or send
   provider traffic. Partial failure removes only the new temporary files.

## Rotation, recovery, trust limitations

New versions mean a new immutable configuration directory and separately reviewed
service restart. Old config remains available for a compatible rollback; revoke
obsolete versions and securely dispose of old host files after the retention
decision. Removing files is not guaranteed secure erasure on SSDs or snapshots.
No secret values are in the output receipt (the helper prints only fixed status).
Local private files and Docker process environment remain readable to root and
Docker/OS administrators: those identities are privileged and require review.
The CLI/project/ID allowlists are operator-controlled checks, not substitutes for
IAM. A compromised same-user process or host root is outside this file-mode boundary.

## Evidence

- `uv run pytest -p no:cacheprovider scripts/tests/test_staging_secrets.py -q`:
  **13 passed**, mocked cloud command only. Covers allowlists, numeric pins,
  invalid payloads, dry run, atomic completion and partial-failure preservation.
- `scripts/tests/staging_secrets_posix_check.py` executed in the local candidate
  migrator container with `--network none --read-only --tmpfs /tmp` and read-only
  helper/test mounts: **passed** actual Linux `0700/0600`, existing-path, symlink,
  relative-path and unsafe-parent refusal. `gcloud` was replaced by a local fake.
- Real IAM/Secret Manager availability, actual service payload correctness and
  GCP deployment remain **PENDING AUTHORIZED STAGING VALIDATION**.

Official API contract: [gcloud secrets versions access](https://docs.cloud.google.com/sdk/gcloud/reference/secrets/versions/access)
and [Secret Manager access requirements](https://docs.cloud.google.com/secret-manager/docs/access-secret-version).
