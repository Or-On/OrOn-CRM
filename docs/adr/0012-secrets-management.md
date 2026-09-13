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

Deployed environments use an operator-selected external secret store or private
host-mounted files and a least-privilege runtime identity. CI must use short-lived
credentials when publication is separately enabled; static hosting keys are
never committed. Provider credentials that must be persisted in PostgreSQL use
application-level authenticated encryption with a master key outside PostgreSQL.
Evaluate Or-on's existing secret code before introducing new cryptography.

## Consequences

Secret references, access policy, rotation, and audit ownership become explicit.
Local and deployment secret delivery remains operator-managed. The repository implements redaction and
scanning foundations but not final credential persistence.

## Verification

Configuration redaction tests, repository secret scans, container inspection, and
future rotation and envelope-encryption tests.
