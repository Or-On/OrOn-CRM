# GCP development environment

This root contains constraints and the future one-VM resource contract only. It
does not define or create billable resources in Phase 1, has no backend or secret
values, and must never require GCP credentials for local verification.

Future reviewed resources are limited to VPC/subnet/firewall, reserved IP, one
Compute Engine VM, one persistent SSD, Artifact Registry, private GCS media and
backup buckets, Secret Manager resource metadata, a least-privilege VM service
account, Workload Identity Federation for CI, and optional DNS.

Before resources are added:

1. decide exact project/region/domain inputs without committing values;
2. define state storage and locking without secret values;
3. run `terraform fmt`, `terraform init -backend=false`, and `terraform validate`;
4. review `terraform plan` for cost, exposure, replacement, and IAM scope;
5. obtain explicit authorization before any `terraform apply`.

Cloud SQL, GKE, Kubernetes, Cloud Run, multiple app VMs, and a service mesh are
outside the accepted Phase 1 target.
