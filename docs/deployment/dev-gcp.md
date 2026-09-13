# GCP development deployment

## Architecture decision

The development environment uses the smallest production-shaped topology that
keeps the platform secure and repeatable. It does not duplicate production
high availability.

```text
GitHub main push
  -> existing CI (all jobs must succeed)
  -> GitHub OIDC / Workload Identity Federation
  -> immutable SHA images in Artifact Registry
  -> IAP + OS Login deployment to oron-dev
  -> Docker Compose private networks
       +-- Caddy :80/:443 -> Next.js web :3000
       +-- FastAPI control API :8000 (private)
       +-- messaging worker (private)
       +-- voice dispatcher :8082 (private, outbound providers)
       +-- PostgreSQL 18 :5432 (internal network only)
       +-- persistent database, Caddy, and call-object directories
```

Caddy is retained because it is already the repository's hardened deployment
edge and provides automatic public certificates and redirects. Adding Nginx and
Certbot would duplicate that responsibility. The framework runtime is a
production Next.js server (`NODE_ENV=production`), even though the data,
hostname, and infrastructure are DEV. No framework development server runs on
the VM.

DEV includes one durable VM, TLS, a private database, least-privilege runtime
roles, persistent storage, health checks, bounded container logs, backups,
immutable images, a deployment lock, and CI-gated CD. Production should later
add a managed database, regional/high-availability application capacity,
load-balancing, managed object storage, centralized observability, and a formal
disaster-recovery policy. Those are intentionally absent from DEV.

## Environment inventory

| Item                       | Value                                                      |
| -------------------------- | ---------------------------------------------------------- |
| GCP project                | `website-478708` (`157867817612`)                          |
| Region / zone              | `me-west1` / `me-west1-b`                                  |
| VM                         | `oron-dev`, Ubuntu 26.04 LTS, `e2-medium`, 40 GB boot disk |
| Public / private IP        | `34.165.22.57` / `10.208.0.3`                              |
| Hostname                   | `dev.or-on.io`                                             |
| Runtime service account    | `oron-dev-runtime@website-478708.iam.gserviceaccount.com`  |
| Deployment service account | `oron-github-dev@website-478708.iam.gserviceaccount.com`   |
| Registry                   | `me-west1-docker.pkg.dev/website-478708/or-on-platform`    |
| Database                   | PostgreSQL 18, `dev_oron_platform`                         |
| Application database roles | `platform_web`, `platform_voice`, `platform_messaging`     |
| Migration role             | `platform_migrator`                                        |
| Public ports               | TCP 80 and 443 only                                        |

PostgreSQL is not published to the host. Its `database` Compose network is
internal, and application roles retain the grants and row-level-security model
created by Alembic. The migrator password is never used by an application
service.

## VM layout and secrets

```text
/opt/oron-dev/
├── current -> releases/<commit-sha>
├── releases/<commit-sha>/
├── shared/
│   ├── deployment.env
│   ├── config/*.env
│   └── data/{postgres,caddy,objects}/
├── scripts/
├── logs/
├── backups/
└── deployed-commit
```

The completed runtime environment is stored only under
`/opt/oron-dev/shared`. Configuration and credential files are owned by root
with mode `0600`. This single-VM DEV deployment deliberately uses protected
host files rather than fetching every variable from Secret Manager on each
restart: it avoids making Secret Manager and network access prerequisites for a
reboot. Existing third-party credentials are copied from the trusted operator
environment; new database and internal keys are generated cryptographically by
`scripts/render_deployment_config.ts`. Neither is committed or printed in CI.

Re-rendering configuration creates a new directory and refuses to overwrite an
existing one. It is an operator action because rotating database or encryption
keys requires a coordinated migration:

```bash
pnpm exec tsx scripts/render_deployment_config.ts \
  --source .env \
  --output /private/new-config \
  --origin https://dev.or-on.io \
  --database dev_oron_platform \
  --owner-email support@or-on.io \
  --tenant-name 'Or-On DEV' \
  --tenant-slug or-on-dev \
  --tls-email support@or-on.io
```

## One-time VM bootstrap

The bootstrap installs/validates Docker and Compose, creates the service user
and persistent directories, installs the pinned Artifact Registry credential
helper, adds a 2 GB swap safety net for the four-GB DEV VM, and enables the
application and backup units. It is separate from ordinary releases.

```bash
sudo REGISTRY_HOST=me-west1-docker.pkg.dev ./scripts/bootstrap-dev-vm.sh
```

The private generated `deployment.env` and `config` directory must then be
transferred to `/opt/oron-dev/shared/` and set to root ownership and mode
`0600`. Do not put them in VM metadata, Git, a release archive, or a command
line.

## CI and continuous deployment

`.github/workflows/ci.yml` remains the sole CI workflow. On an exact push to
`main`, its container job authenticates with GitHub OIDC, publishes five
commit-SHA images, and records no mutable deployment tag. `deploy-dev` has
`needs` on every CI job, so a failed or cancelled check cannot deploy.

The `github-oron-dev/oron-crm-main` Workload Identity provider trusts only
`Abssel-AI/OrOn-CRM` on
`refs/heads/main`. The deployment service account can write the one registry,
inspect the target VM, open an IAP tunnel, use OS Admin Login, and act as the
target VM service account for SSH. No JSON service-account key or GitHub secret
is used.

The exact deployment bindings are:

- `roles/artifactregistry.writer` on only the `or-on-platform` repository.
- `roles/compute.viewer`, so deployment can resolve the named VM and zone.
- `roles/compute.osAdminLogin`, so the deployment can execute the root-owned
  release script through audited OS Login and `sudo`.
- `roles/iap.tunnelResourceAccessor`, so SSH does not require direct internet
  exposure.
- `roles/iam.serviceAccountUser` on only the VM's runtime service account,
  required by Compute SSH when a service account is attached.
- `roles/iam.workloadIdentityUser` on the deployment service account, granted to
  the exact repository principal set. The provider condition narrows it again
  to `refs/heads/main`.

The runtime service account has `roles/artifactregistry.reader` on only the
image repository. Its former project-wide Editor and unused Cloud SQL Client
bindings were removed because this deployment uses local PostgreSQL and does
not call GCP APIs at runtime.

The VM uses target tags `oron-dev-web` and `oron-dev-secure`. Target-scoped
rules allow public TCP 80/443, allow TCP 22 from the IAP proxy range at priority
800, and deny all other TCP 22 traffic at priority 900 before the shared
project-wide default allow rule. Older generic HTTP/HTTPS and local-LiveKit tags
were removed from this VM; unrelated rules and VMs were not changed. A host
firewall is intentionally not layered over Docker NAT because the VPC rules are
the authoritative ingress boundary and no Compose service publishes an
internal port.

The deploy job resolves every tag to an immutable digest, creates a secret-free
release archive, transfers it over IAP, and runs:

```bash
sudo /opt/oron-dev/scripts/deploy-dev.sh \
  <40-character-commit-sha> /tmp/oron-dev-release-<commit-sha>.tar.gz
```

The script validates the archive, acquires `flock`, pulls images before
touching the running release, starts PostgreSQL, runs Alembic, bootstraps the
first owner only on an empty identity database, updates services, verifies HTTPS
and the HTTP redirect, then atomically updates `current`. It never deletes
`shared/data`.

## Migrations, health, and service control

Alembic is the only migration authority. Each release runs the one-shot
`migrator` container and refuses to start new application images if migration
fails. Migration changes must remain compatible with the immediately previous
application release so application rollback remains safe.

```bash
sudo systemctl status oron-dev --no-pager
sudo systemctl restart oron-dev
cd /opt/oron-dev/current
sudo docker compose \
  --env-file /opt/oron-dev/shared/deployment.env \
  --env-file images.env -f infra/compose/deployment.yaml \
  --profile workers --profile voice ps
curl -fsS https://dev.or-on.io/login >/dev/null
```

Container health checks cover PostgreSQL, control-API database readiness,
dispatcher readiness, and the Next.js login route. Caddy itself is validated by
the external HTTPS request. Docker and `oron-dev.service` are enabled at boot;
containers also use `restart: unless-stopped`.

## Logs

Container logs use Docker's bounded local driver (10 MB, three files per
container). Caddy access logs are disabled because callback URLs can contain
sensitive provider state.

```bash
sudo journalctl -u oron-dev -f
sudo journalctl -u oron-dev-backup.service --since today
sudo docker compose \
  --env-file /opt/oron-dev/shared/deployment.env \
  --env-file /opt/oron-dev/current/images.env \
  -f /opt/oron-dev/current/infra/compose/deployment.yaml \
  --profile workers --profile voice logs --tail=200 -f
sudo docker compose \
  --env-file /opt/oron-dev/shared/deployment.env \
  --env-file /opt/oron-dev/current/images.env \
  -f /opt/oron-dev/current/infra/compose/deployment.yaml logs postgres
```

## Backups and restore

`oron-dev-backup.timer` creates a custom-format `pg_dump` every night and
deletes DEV dump files older than seven days. Run one immediately with:

```bash
sudo systemctl start oron-dev-backup.service
sudo ls -lh /opt/oron-dev/backups
```

Restore is an explicit maintenance action. Stop application services, retain a
copy of the current database, then stream the chosen dump into `pg_restore`:

```bash
sudo systemctl stop oron-dev
release=/opt/oron-dev/current
sudo docker compose \
  --env-file /opt/oron-dev/shared/deployment.env \
  --env-file "$release/images.env" -f "$release/infra/compose/deployment.yaml" \
  up -d postgres
sudo docker compose \
  --env-file /opt/oron-dev/shared/deployment.env \
  --env-file "$release/images.env" -f "$release/infra/compose/deployment.yaml" \
  exec -T postgres pg_restore --clean --if-exists --no-owner \
  -U platform_migrator -d dev_oron_platform \
  </opt/oron-dev/backups/<selected-dump>
sudo systemctl start oron-dev
```

## Rollback

Automatic rollback restores the previous images when a post-deploy health
check fails. A migration is not automatically reversed and the pre-release
backup is retained. For an operator rollback, select a retained release and
start it before changing the symlink:

```bash
previous=/opt/oron-dev/releases/<previous-commit-sha>
sudo docker compose \
  --env-file /opt/oron-dev/shared/deployment.env \
  --env-file "$previous/images.env" -f "$previous/infra/compose/deployment.yaml" \
  --profile workers --profile voice up -d --remove-orphans --wait --wait-timeout 240
sudo ln -sfn "$previous" /opt/oron-dev/current.next
sudo mv -Tf /opt/oron-dev/current.next /opt/oron-dev/current
printf '%s\n' '<previous-commit-sha>' | sudo tee /opt/oron-dev/deployed-commit >/dev/null
```

## TLS and troubleshooting

Caddy automatically issues and renews the public certificate. Its persistent
state is `/opt/oron-dev/shared/data/caddy`. Check certificate automation with
the Caddy container logs; never copy its private keys into Git.

If the endpoint returns `502`, inspect `web` and `control-api` health first. If
the app starts but identity operations fail, confirm Alembic head and database
role grants through the migrator. If image pulls fail, verify the VM service
account still has Artifact Registry Reader on `or-on-platform` and run
`sudo HOME=/root docker-credential-gcr configure-docker
--registries=me-west1-docker.pkg.dev`. If GitHub cannot connect, validate IAP,
OS Login, the exact repository/ref condition, and the deployment service
account bindings before changing any firewall rule.
