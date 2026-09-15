# CRM post-implementation evidence

Execution date: 2026-09-15. This directory records the implementation and
validation performed against the current dirty working tree. It is evidence for
review, not a claim that the uncommitted tree is deployed or that every external
provider completed a real action.

## Evidence index

- [Baseline](baseline.md): repository identity, source snapshot, toolchain,
  migration state and available runtimes.
- [Application inventory](inventory.md): finite page/API/background-work map.
- [Coverage matrix](coverage-matrix.md): user journeys, roles, guards, source
  anchors and local/deployed/provider status.
- [Findings and fixes](findings.md): implemented defects and ranked remaining
  issues.
- [Security review](security-review.md): risk-based ASVS 5.0.0 review and
  dispositions.
- [Test results](test-results.md): exact commands, counts, skips and failures.
- [UI evidence](ui-evidence.md): responsive, theme, locale and browser evidence
  boundaries.
- [Release assessment](release-assessment.md): separate local, DEV, provider and
  production verdicts.

Field-service provenance and operations are documented separately in the
[source-to-target map](../../migration/brimag-field-service-map.md),
[field-service validation](../../migration/field-service-validation.md) and
[operator runbook](../../runbooks/field-service.md). Deployment, backup and
rollback procedures are in the [DEV deployment runbook](../../deployment/dev-gcp.md).

## Evidence rules used

- `PASS` means the cited local command or deterministic test completed on the
  source snapshot in [Baseline](baseline.md).
- `BLOCKED` means a named prerequisite was unavailable; it never means pass.
- `NOT APPLICABLE` is used only where the product intentionally does not expose
  the capability and the reason is recorded.
- Simulated-provider evidence is kept separate from real-provider evidence.
- No shared migration, deployment, real message, call, calendar write or payment
  was performed during this execution.
