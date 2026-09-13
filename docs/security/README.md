# Security documentation

- [Threat model](threat-model.md) distinguishes Phase 1 controls from planned
  controls and is the authoritative security-status statement.
- [ADR 0012](../adr/0012-secrets-management.md) defines local and deployed
  secret handling.
- [ADR 0011](../adr/0011-authentication-selection-process.md) defines the
  evidence required before selecting canonical authentication.

Security findings must not be placed in normal logs or public issues when they
contain exploitable details, credentials, customer data, or provider identifiers.
Phase 1 has no production security certification or feature-parity claim.
