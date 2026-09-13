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
