# Protected staging candidate workflow

Status: **implemented and locally statically tested; GitHub execution, cloud IAM,
registry publication and deployment remain unverified**. No workflow was triggered,
no cloud credentials were requested and no images were uploaded during this task.

`/.github/workflows/staging-candidate.yml` is manually invoked only. It verifies
the exact triggering commit, using fictional PostgreSQL on port 55439 and all
real-provider flags off. Code/contract/security checks, full Python/TypeScript
tests, isolated live worker tests and production builds precede packaging.
The `staging` environment gates packaging. Defaults are **do not publish** and
**do not deploy**. Requesting deployment without publication fails immediately.

Packaging builds web, control-api, messaging-worker and migrator images for
Linux amd64. Syft 1.51.1 and Grype 0.118.0 binaries are checked against fixed
release SHA-256 checksums. All four images must pass the high-severity gate;
there is no blanket `ignore-unfixed` or exception that turns current findings
green. SBOMs and JSON reports are retained as private workflow artifacts for
14 days. They are not customer data, credentials or environment dumps.

Only an explicitly requested image publication after review invokes keyless
Google federation. No service-account JSON keys are used. Publication creates no
workspace credentials file. A short-lived access token is passed to Docker on stdin and stored
only in the ephemeral runner's private Docker configuration. Images are tagged
with source commit + run + attempt, then recorded using exact registry digests.
The helper rechecks scan hashes and local image IDs immediately before publishing.
The JSON scan record is an internal integrity receipt, **not a signed third-party
attestation or proof that every risk is absent**.

An optional VM deployment job follows successful publication and a **separate
`staging-deployment` environment approval**. The actual federated deployment job
retains environment `staging` to match Terraform's exact WIF subject. It downloads
only this run/attempt's artifact, checks source SHA, registry digests and scan-file
hashes, then uses IAP TCP forwarding and OS Login with an expiring SSH key. The VM's
Ed25519 host key must match an operator-verified pin; trust-on-first-use is disabled.
The auth action creates an ephemeral runner credentials file for gcloud, removes
it after the job, and never uploads it or forwards credentials to the VM.

`staging_vm.py` is dry-run unless `--execute` is explicitly supplied. Remote
`staging_vm_host.py` requires operator-prepared, root-owned, non-symlink host
configuration and an exact-SHA release directory whose executable release script,
Compose and Caddy files match the reviewed CI checkout hashes. It passes a minimal
environment to `python3 -I .../release.py deploy --execute`. Private configuration
must already exist with owner-only permissions, and the separate data disk must
already be mounted. No bootstrap, source installation, secret retrieval, Terraform
apply, worker start or provider enabling occurs. Workers remain off after release;
authenticated functional smoke and rollback approval remain operator gates.

**Current high/critical image scan failures block publication and deployment.**
This prepared path has not executed in GitHub or against a VM. A recorded image
manifest says NOT DEPLOYED until a separately approved release actually executes.

## Exact setup before a future authorized run

1. Commit/review the final candidate and enable normal CI. Do not run this workflow
   from the dirty local candidate or substitute a different checkout SHA.
2. In GitHub configure environments `staging` and `staging-deployment`: required reviewers, prevent self-review,
   disable bypass where available, and allow only the exact protected deployment
   branch. These settings are not enforceable merely by declaring a YAML environment.
3. Set repository/environment variables (metadata only):

   | Variable                         | Exact matching infrastructure value                                        |
   | -------------------------------- | -------------------------------------------------------------------------- |
   | `STAGING_GIT_REF`                | Terraform `github_ref`, including `refs/heads/`                            |
   | `STAGING_REPOSITORY_ID`          | Verified numeric `github_repository_id`                                    |
   | `STAGING_REPOSITORY_OWNER_ID`    | Verified numeric `github_repository_owner_id`                              |
   | `STAGING_IMAGE_REPOSITORY`       | Terraform `image_repository` output, without a service/tag                 |
   | `STAGING_WIF_PROVIDER`           | Terraform `workload_identity_provider` output                              |
   | `STAGING_DEPLOY_SERVICE_ACCOUNT` | Terraform `deployment_service_account` output                              |
   | `STAGING_GCP_PROJECT_ID`         | Exact approved GCP project ID                                              |
   | `STAGING_VM_NAME`                | Terraform `vm_name` output                                                 |
   | `STAGING_VM_ZONE`                | Terraform `vm_zone` output                                                 |
   | `STAGING_SSH_HOST_PUBLIC_KEY`    | Verified VM Ed25519 public host key, `ssh-ed25519 BASE64`, without comment |
   | `STAGING_GCLOUD_VERSION`         | Operator-reviewed exact Cloud SDK version, `MAJOR.MINOR.PATCH`             |

4. Terraform **must** use `github_workflow_path = ".github/workflows/staging-candidate.yml"`
   and `github_environment = "staging"`. The input is intentionally configurable,
   but the provider's `workflow_ref`, repository/owner IDs, ref, environment, subject
   and `workflow_dispatch` condition must all match this exact workflow. Using
   the example's old `deploy-staging.yml` value will correctly deny federation.
5. After cloud provisioning is separately authorized, test federation/IAM without
   widening scopes to work around denial. Registry writer is repository-scoped;
   no provider secrets are passed into the workflow. Host/secret/DNS/budget/privacy
   preparation remains a separate operator checklist.
6. Run once with both inputs false and inspect every gate and SBOM. A successful
   package is not an authenticated staging functional test. Publish only after
   blocker resolution and explicit environment approval. Opt-in `deploy_vm` also
   requires `publish_images`, plus the second environment's approval after packaging.
   Review that run's digest manifest before approving the VM release.

## Host bootstrap contract (operator-owned, not executed by this workflow)

After separately authorized provisioning and the deployment/recovery runbook:

- Mount the separate staging disk at `/srv/or-on-platform`; prepare Caddy volume
  ownership and the reviewed owner-only service environment files under
  `/srv/or-on-platform/private-config/REVIEWED_RELEASE` using the secret-retrieval
  runbook. Configure root Docker registry pulls using the VM runtime identity.
  The deployment job does not forward registry or provider credentials to the host.
- Install Docker/Compose, Python 3 and OS Login/IAP requirements on the reviewed VM.
  Verify its SSH host public key through a trusted operator channel, not by disabling
  SSH checks. Record only its public key in the GitHub metadata variable.
- Preinstall the reviewed release source at `/opt/oron-platform/releases/FULL_SHA`.
  This path and every ancestor/source file must be root-owned, not group/world
  writable and not symlinks. CI does not fetch arbitrary branches or install source
  as root. The three files used by the release are SHA-256 compared to the exact
  checked-out commit; the full source SHA also binds the image manifest and path.
- Create `/etc/oron-staging/host.json` as root, mode `0600`, in a root-owned safe
  directory. Review all fields, including the explicit CI deployment opt-in:

```json
{
  "version": 1,
  "ci_deploy_enabled": true,
  "repository_id": "VERIFIED_NUMERIC_REPOSITORY_ID",
  "ref": "refs/heads/REVIEWED_BRANCH",
  "project": "reviewed-project-id",
  "vm": "reviewed-staging-vm",
  "zone": "me-west1-a",
  "environment": {
    "PLATFORM_ORIGIN": "https://staging.example.invalid",
    "STAGING_ALLOWED_CIDRS": "192.0.2.1/32",
    "CADDY_ACME_EMAIL": "ops@example.invalid",
    "STAGING_CONFIG_DIR": "/srv/or-on-platform/private-config/REVIEWED_RELEASE"
  }
}
```

Values are placeholders, not deployable configuration. The helper rejects missing
bootstrap, mismatched target/repository/ref, changed release files, unmounted data,
unsafe paths and additional environment keys (including Docker remote overrides)
before invoking release commands. It performs no automatic host repair. A failed
migration/release leaves writers stopped and requires recovery review; do not
restart workers or downgrade the schema automatically.

## Local verification and sources

`infra/tests/test_staging_images.py`: 13 tests passed (input guards, manual-run
identity, dry-run no commands, image/scan tampering, failed-scan behavior and
workflow protections). Ruff check/format passed for the helper/tests. These
tests use no provider/cloud calls and do not claim Docker/registry execution.
`infra/tests/test_staging_vm.py`: 22 tests passed for exact-run manifest binding,
scan failure/tampering, command injection refusal, dry-run no operations, pinned
IAP command construction (including pin precedence over SDK defaults), host bootstrap/source/mount/environment refusals and
isolated release invocation. Host ownership/mount and SSH orchestration tests use
controlled test doubles; they **do not prove live Linux/IAM/SSH/deployment behavior**.

New action SHAs and scanner archive checksums were verified against official
GitHub release metadata on 2026-09-12. Design references:
[Google GitHub auth](https://github.com/google-github-actions/auth),
[Google Cloud SDK setup](https://github.com/google-github-actions/setup-gcloud),
[gcloud compute SSH](https://docs.cloud.google.com/sdk/gcloud/reference/compute/ssh),
[IAP TCP forwarding](https://docs.cloud.google.com/iap/docs/using-tcp-forwarding),
[protected GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments),
[Syft](https://github.com/anchore/syft), and
[Grype](https://github.com/anchore/grype).
