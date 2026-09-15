# Release assessment

Assessment date: 2026-09-15. Candidate identity is the dirty working-tree
snapshot in [Baseline](baseline.md), not a Git commit or deployed release.

## Separate verdicts

| Boundary | Verdict | Basis |
| --- | --- | --- |
| Local implementation | **CONDITIONAL PASS** | Formatting, lint, TS/Python type checks, 2,042 passed automated tests, production build, contract generation, offline migration contract, dependency checks and focused release/security regressions passed. Conditions: supported Node rerun and online DB/device/provider evidence remain. |
| Deployed DEV | **BLOCKED** | Public reachability was observed, but exact source/image/schema identity and authenticated ordinary-role journeys were not available. This working tree was not pushed/deployed. |
| Real-provider workflows | **BLOCKED** | No authorized run manifest; no real Meta delivery, two-way call, OAuth/OCR, calendar write or Stripe test transaction was performed. Simulator results remain labeled local. |
| Production readiness | **NOT READY** | Online PostgreSQL/RLS/restore, exact-release E2E, provider/device acceptance, off-host DR, supported runtime evidence and production HA/observability decisions are incomplete. |

`2,042` is 977 passing TypeScript/React tests plus 1,065 passing Python
tests. The 202 explicitly skipped tests are not included.

## Release-blocking checklist

1. Create an owned disposable PostgreSQL 18.6 environment, apply the entire
   migration chain and execute all currently DB-gated TypeScript/Python
   checks, including RLS, triggers, race conditions, upgrade/downgrade and an
   isolated complete backup restore.
2. Run all pnpm gates under Node `>=24.20.0 <25` and build/scan the exact five
   immutable images.
3. Review the 162-path dirty working tree, preserve intended changes, produce a
   reviewed commit and allow CI to create immutable digest/source evidence.
4. Deploy only with explicit authority; verify intended SHA, five image digests,
   schema head, prior optional profiles, pending jobs and active-call drain.
5. Run authenticated DEV acceptance with disposable records for every role and
   a second tenant, including browser/mobile/RTL/theme/accessibility checks.
6. Establish a bounded live-provider manifest, then validate WhatsApp, voice and
   cross-channel flows one provider at a time. Use only controlled identities,
   recipients and test-mode payments.
7. Configure encrypted off-host backup retention and restore the database plus
   private objects/recordings into a separate destination. Agree DEV and
   production RPO/RTO.
8. Resolve or explicitly accept every P1 in [Findings](findings.md). A release
   cannot use local unit/build success to waive these boundaries.

## Provider run manifest status

No manifest was created because this request supplied neither release authority
nor controlled accounts/recipients/spend. Before live acceptance, record:

- exact candidate SHA/image digests/schema and QA tenant/user roles;
- controlled WhatsApp sender/recipient and call number/person able to answer;
- provider modes, permitted templates/actions, maximum message/call count,
  duration and spend;
- test window, stop conditions, owned artifact identifiers and cleanup/retention;
- allowed OAuth/OCR/calendar/payment test accounts and scopes.

Absence of this manifest blocks external side effects only; it did not prevent
the completed local implementation and simulated-provider contracts.

## Rollout, rollback and recovery

The reconciled procedure is in the [DEV deployment runbook](../../deployment/dev-gcp.md).
Source tests require archive checksum/type/path integrity, five distinct image
digests, OCI revision match, active-call drain, admission/writer stop, complete
pre-migration backup, migration, exact running-image verification and rollback
to only the previously active profiles. The backup contains database, private
objects/recordings and release/schema metadata with checksums.

These procedures are **locally contract-tested only**. A separate-destination
restore and off-host retention are release blockers; a database dump on the
same VM is not disaster recovery.

## Operator setup boundaries

- Field service is disabled by default. A platform administrator grants the
  entitlement; an owner/admin then activates the tenant module and each
  WhatsApp/AI-scheduling/OCR/shared-login option independently.
- Manual scheduling works without provider credentials. Read-only calendar
  state permits suggestions only; current CRM calendar selection is not claimed
  as an external provider booking.
- Private objects require a protected shared filesystem in the documented DEV
  topology. `ARTIFACTS_BACKEND=gcs` fails closed because no GCS adapter is
  implemented; cloud hosting alone does not change that fact.
- Existing messaging remains enabled when field service is disabled. Historical
  authorized archives remain readable; queued field-service side effects cancel
  after rechecking current activation.

## Final recommendation

Do not push-to-deploy or promote this candidate solely from this local result.
The code is substantially more complete and the locally available gates are
green, but the release decision is intentionally blocked at the database,
exact-deployment, provider/device and disaster-recovery boundaries.
