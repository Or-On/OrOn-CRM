# ADR 0012: Secrets management

- Status: Accepted
- Date: 2026-08-31
- Owners: Security and platform engineering

## Context

The platform will eventually handle telephony, WhatsApp, AI-provider, storage,
database, and signing credentials. Leaking any of these through source, images,
fixtures, logs, Terraform state, or diagnostics could enable tenant breakout,
provider abuse, or data loss.

## Decision

Local development uses ignored environment files with restrictive filesystem
permissions where practical. Source, images, fixtures, and logs contain no secret
values. Typed configuration redacts sensitive fields and real-provider flags
default to false.

The future GCP environment uses Secret Manager, VM service identity, and Workload
Identity Federation for CI; service-account JSON is never committed. Terraform
references secret resources without placing secret values in configuration or
state. Provider credentials that must be persisted in PostgreSQL use
application-level authenticated encryption with a master key outside PostgreSQL.
Evaluate Or-on's existing secret code before introducing new cryptography.

## Consequences

Secret references, access policy, rotation, and audit ownership become explicit.
Local environment files remain operator-managed. Phase 1 implements redaction and
scanning foundations but not final credential persistence.

## Verification

Configuration redaction tests, repository secret scans, container inspection, and
future rotation and envelope-encryption tests.
