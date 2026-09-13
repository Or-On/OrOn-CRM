# Deployment configuration boundary

These templates describe the private configuration files consumed by
`infra/compose/deployment.yaml`. Copy them to an absolute directory outside the
repository, replace every placeholder, and restrict permissions to the
deployment operator. Do not commit completed copies.

The hosting account, registry, DNS, firewall, secret delivery, and backup
destination are deliberately not modeled here. Images may come from any OCI
registry as long as the Compose variables use immutable digest references.
