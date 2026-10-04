# Deployment configuration boundary

These templates describe the private configuration files consumed by
`infra/compose/deployment.yaml`. Copy them to an absolute directory outside the
repository, replace every placeholder, and restrict permissions to the
deployment operator. Do not commit completed copies.

The hosting account, registry, DNS, firewall, secret delivery, and backup
destination are deliberately not modeled here. Images may come from any OCI
registry as long as the Compose variables use immutable digest references.

`scripts/render_deployment_config.ts` can create a complete private directory
from a trusted local environment without printing credentials. The renderer
requires a lowercase `dev_` database name for a DEV deployment, creates each
database role password independently, and refuses to overwrite its output.
`scripts/bootstrap-dev-vm.sh` and `scripts/deploy-dev.sh` retain the same
portable Compose boundary; the concrete GCP DEV wiring is documented in
`docs/deployment/dev-gcp.md`.

## Health recovery remains opt-in

The worker probe requires a fresh successful-poll heartbeat and a bounded DB
query. Caddy's new loopback-only liveness listener returns a fixed `OK` without
depending on web or exposing customer/status data. Docker marks unhealthy
containers; its restart policy alone does not recover a still-running unhealthy
process. Web and messaging-worker startup now depend on PostgreSQL rather than
the unrelated control-api process.

`scripts/recover_unhealthy.py` defaults to dry-run. The provided recovery
systemd service/timer are **not installed or enabled by deploy-dev.sh**. An
operator must review installation, copy the script/units into the release,
create the private `shared/enable-health-recovery` marker and explicitly enable
the timer. Removing the marker disables execution; disable the timer to roll
back. It shares the deployment lock, only restarts running unhealthy web,
messaging-worker or Caddy with `--no-deps`, and never restarts PostgreSQL,
migrations, dispatcher or bootstrap. Recovery preserves the worker's 90-second
drain timeout (45 seconds for web/Caddy). Each service has a five-minute cooldown
and at most two restart attempts per fifteen minutes, persisted before restart.
Failure consumes budget; corruption/clock rollback fails closed. Database readiness
failure suppresses web/worker recovery to avoid restart churn during a DB outage;
Caddy liveness remains independent. Only container status fields are inspected,
not health logs or environment values. Persistent
failure requires an operator; this is not an external alerting service.

Before activation, verify `curl` is present in the exact pinned Caddy image and
exercise the loopback probe and recovery with synthetic faults. Local Windows
verification has no running Docker daemon; source tests are not a deployed
container or scheduler acceptance result.

## Resource and storage boundaries

The measured existing host has 3907 MiB RAM. The limits for the full long-running
stack total 7424 MiB (PostgreSQL 2048, five application services 5120, Caddy 256),
before host/kernel, Docker, transient migration/build work or optional voice
providers. These limits are ceilings, not measured simultaneous demand. The
existing host is not certified safe by lowering ceilings without workload
measurements. A reviewed machine-capacity change (the document proposes 16 GiB)
and comparable load/RSS measurements remain required.

`infra/compose/no-swap.yaml` is an optional reviewed overlay: its memory+swap
limits equal each service's memory limit, preventing container swap. It is not
automatically applied and does not solve overcommit. Do not activate it on the
current host without a capacity/load review. Log files remain bounded locally
(30 MiB per service); off-host log retention/alerts and recording/object storage
capacity remain external provisioning tasks. Existing pre-deploy backup uses
database-only mode; no destructive recording cleanup is introduced here.
