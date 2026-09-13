# GCP staging Terraform implementation and verification

Date: 2026-09-12. Status: **verified-local configuration and mock-provider
policy tests; not planned against GCP, not applied, not deployed**.

Scope is `infra/terraform/environments/staging/` only. Historical `dev` files,
the user's running processes, cloud state, secrets and upstream repositories
were not modified. This is one part of staging readiness, not the release gate.

## Resource contract

| Resource | Implemented boundary |
| --- | --- |
| Compute | One shielded VM, Secure Boot/vTPM/integrity monitoring, no IP forwarding, no arbitrary automatic startup script; immutable Debian 13 or Ubuntu 24.04 LTS image input required. |
| PostgreSQL data | Separate zonal `pd-ssd`, stable device `/dev/disk/by-id/google-oron-data`, intended mount `/srv/or-on-platform`. VM and disk use Terraform prevent-destroy; VM additionally enables GCE deletion protection. Attached data is independent of the auto-deleted boot disk. |
| Network | Dedicated custom VPC/subnet, reserved external IPv4, public TCP 80/443 only. SSH TCP 22 only from IAP `35.235.240.0/20`. No public PostgreSQL/internal admin/SIP/media ports or blanket internal allow rule. |
| Administration | OS Login, human 2FA metadata, blocked project SSH keys, disabled serial port. IAP tunnel IAM limited to this instance and destination port 22; OS Admin Login limited to this instance. |
| Images | Private regional Docker Artifact Registry with immutable tags and protected deletion. VM can read; deploy identity can publish. |
| Media | Private uniform-access bucket, enforced public-access prevention, versioning and seven-day soft deletion; only noncurrent versions have a 30-day lifecycle rule. Current media is not automatically purged by Terraform. |
| Backups | Separate private versioned bucket, assumed 30-day retention (not irreversibly locked), seven-day soft deletion and lifecycle cleanup after retention. Runtime gets objectCreator only: unique-key upload, not delete/overwrite/read. |
| Secrets | Secret metadata and one-region replication only, with per-secret runtime accessor. No secret version resource, secret value variable, secret output or downloaded service-account key. |
| CI identity | Separate deploy service account; GitHub OIDC is constrained to immutable numeric repository + owner IDs, exact repository, branch ref, GitHub environment, subject, workflow path/ref and manual `workflow_dispatch` event. |
| Telemetry | VM receives only logWriter and metricWriter project roles; actual agent installation, alert policies/thresholds and notification validation remain separate operational work. |

The network rule follows Google's documented [IAP TCP forwarding range and
port-scoped authorization](https://docs.cloud.google.com/iap/docs/using-tcp-forwarding).
No new real media/SIP requirement has been verified, so those ports remain
closed. Caddy must enforce the restricted staging front door while allowing
only the explicitly needed callback/webhook routes.

## Identity and permission review

Federation uses immutable numeric IDs because repository/owner names can be
reused. There is no wildcard repository, wildcard branch, pull-request access,
or unprotected event grant. The GitHub environment must be created with required
reviewers and deployment-branch rules before any use; Terraform does not modify
GitHub settings. This follows [Google's deployment federation guidance](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines).

The deploy identity has repository-scoped artifact writer, instance-scoped OS
Admin Login and IAP SSH, plus serviceAccountUser on only the runtime service
account. A small project custom role provides project metadata discovery for
explicit IAP/OS Login commands, not compute.admin or editor. The VM has no
project-wide secret, storage or artifact administrator permission.

**Trust limitation:** a principal with OS Admin Login can use sudo and therefore
access the VM runtime authority and secrets. It is a privileged deployment
identity, not isolation from the workload. Required review and exact WIF scope
are essential. Human external-organization OS Login may additionally require
organization-level external-user setup, which is intentionally not granted here.
See [OS Login roles and service-account access](https://docs.cloud.google.com/compute/docs/oslogin).

VM secret access uses metadata-server credentials with cloud-platform OAuth
scope; IAM is narrowed on individual secrets. This matches [Secret Manager
least-privilege guidance](https://docs.cloud.google.com/secret-manager/docs/best-practices)
and its [Compute Engine scope requirement](https://docs.cloud.google.com/secret-manager/docs/manage-access-to-secrets).
Secret payload creation/rotation is an out-of-band operator action, never a
Terraform input. `secret_ids` may name a reviewed runtime environment bundle;
the deploy/host runbook must define its format and write it to a root-readable
file without logging contents.

The runtime backup grant is deliberately narrower than objectUser: it cannot
read, delete or overwrite recovery objects. Restore is an explicit operator
operation with temporarily approved read access and a new database target;
do not expand normal runtime permissions merely to make recovery convenient.
See [Cloud Storage role semantics](https://docs.cloud.google.com/storage/docs/access-control/iam-roles).

## State, changes and recovery

The root declares an empty GCS backend. Before authorized cloud planning,
bootstrap a **separate** private state bucket outside this root, with uniform
access, public-access prevention, versioning, recovery/retention controls and
limited infrastructure-operator permissions. Keep backend bucket/prefix in
ignored non-secret local configuration. GCS backend supports locking; concurrent
operators must not bypass it. [HashiCorp GCS backend documentation](https://developer.hashicorp.com/terraform/language/backend/gcs)
describes the pre-existing bucket and locking requirements.

The application deploy service account is not the infrastructure provisioning
identity and receives no state-bucket/IAM/network provisioning role. Review plans
using a separately authorized infrastructure identity. Never run blanket
`destroy`, disable protection as routine cleanup, or restore old state over a
current environment.

Changing project, zone, names or boot image may replace protected resources;
`allow_stopping_for_update=false` prevents automatic disruption for updates that
require stopping. A planned maintenance/replacement procedure must first back
up and restore-test, retain the data disk, quiesce writes, verify filesystem
identity, then explicitly authorize a compatible replacement. `prevent_destroy`
is a review guard, not a backup or an absolute defense if configuration is
removed. Provider-side VM protection is also not disk-content recovery.

No startup script formats or mounts a device. Before application startup, the
host-preparation workflow must resolve the exact disk, format **only a verified
new blank device**, refuse unknown filesystem contents, mount the expected
filesystem persistently, and verify the mount before creating PostgreSQL data.
Do not let a missing disk silently redirect database data onto the boot disk.
See [Persistent Disk lifecycle](https://docs.cloud.google.com/compute/docs/disks/persistent-disks).

## Local verification evidence

Toolchain: [Terraform 1.16.2](https://releases.hashicorp.com/terraform/1.16.2/)
and [Google provider 8.2.0](https://registry.terraform.io/providers/hashicorp/google/8.2.0/docs/resources/compute_instance),
verified as stable releases on the audit date. The Windows binary was downloaded
only to ignored `staging/.terraform/tools/`, SHA-256 compared against HashiCorp's
release checksum list before execution. Distribution SHA-256:
`6ef140ce1d399dc43b8315194176ddc2dfb5c21d607968e82ef20a55cfff40d0`.
No tool was globally installed or added to PATH.

| Command (inside staging root) | Observed result |
| --- | --- |
| `terraform version` | Terraform 1.16.2 / windows_amd64. |
| `terraform init -backend=false -input=false -no-color` | Passed; installed Google 8.2.0 signed by HashiCorp; no remote state/cloud identity used. |
| `terraform fmt -recursive` then `terraform fmt -check -recursive` | Passed. Only new staging files formatted. |
| `terraform validate -no-color` | Passed: configuration valid. |
| `terraform providers lock -platform=linux_amd64 -platform=windows_amd64 -no-color` | Passed; generated `.terraform.lock.hcl` includes both platform checksums. |
| `terraform test -no-color` | **4 passed, 0 failed**, mock-provider plans only; protected topology and floating-image/wrong-zone/name-based-ID refusal covered. |

Registry access downloads signed provider packages; these checks do not need
GCP credentials. No real plan, apply, cloud read, resource provisioning, payment,
provider send, call, secret retrieval or deployment ran. Mock plans do not prove
actual IAM effectiveness, GCP quota/image availability, DNS, TLS or reachability.

## Explicit assumptions and remaining gates

- Operator must supply dedicated project, region/zone, approved exact OS image,
  domain/DNS, numeric repository/owner IDs, allowed ref, environment reviewers,
  deploy-workflow path, state bucket, secret IDs and human administrators.
- Capacity assumption is one e2-standard-4 (4 vCPU/16 GiB), 100 GiB persistent
  SSD and 30 GiB balanced boot disk, no GPU. This is not a measured sizing
  recommendation; live media/model workloads may exceed it.
- No cost figure is fabricated before the region/workload/storage volume is
  chosen. Approval must price approximately 730 VM-hours/month, disks, reserved
  IPv4, retained/versioned media/backups, registry storage, network egress and
  telemetry, then set a budget/alert in the approved billing account. This
  missing estimate blocks authorization to provision; it does not block syntax
  validation.
- Host Docker/Compose versions, patch policy, mounted-disk startup gate, Caddy
  restricted front door, production secrets, application release workflow,
  backup timers, restore drill, disk/memory/log alerts and their verification
  must be connected before staging. This root does not claim to implement them.
- Outbound network access is not destination-firewalled here because approved
  provider/registry/package endpoints have dynamic IPs. Application egress
  validation and explicit provider flags remain mandatory; no real provider
  capability is enabled by infrastructure.
- All cloud-effective tests remain pending separate authorization: real plan
  review, API/quota availability, IAM positive/negative checks, WIF denial from
  wrong repo/owner/ref/environment/workflow/event, IAP login, private bucket
  access, secret isolation, reserved-IP DNS/TLS, disk mount/restart durability,
  production startup and restore-to-new-database recovery.
