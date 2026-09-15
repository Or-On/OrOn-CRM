# Release assessment

Assessment date: 2026-09-15. The validated implementation is Git commit
`d5cead92603ac6118968f609edd9344efec5fa73`; its exact digest-pinned images and
schema were deployed to DEV by GitHub Actions run `34927297654`.

## Separate verdicts

| Boundary | Verdict | Basis |
| --- | --- | --- |
| Local/CI implementation | **PASS** | Formatting, lint, TS/Python type checks, 2,042 local tests, 128 PostgreSQL tests, 13 cross-channel acceptance cases, production build, contracts, dependency checks and five images passed on the supported CI toolchain. Three separate readiness-environment tests remain explicitly skipped. |
| Deployed DEV | **PASS — deployment boundary** | Exact source, five image digests and schema head were verified; backup/migration and all service health checks passed; HTTP→HTTPS and login checks passed. Authenticated ordinary-role/device acceptance remains a separate blocker. |
| Real-provider workflows | **BLOCKED** | No authorized run manifest; no real Meta delivery, two-way call, OAuth/OCR, calendar write or Stripe test transaction was performed. Simulator results remain labeled local. |
| Production readiness | **NOT READY** | Authenticated exact-release E2E, provider/device acceptance, off-host restore/retention and production HA/observability decisions are incomplete. |

`2,042` is 977 passing TypeScript/React tests plus 1,065 passing Python tests.
CI additionally ran 128 PostgreSQL tests, four isolated messaging diagnostics
and 13 cross-channel cases against disposable PostgreSQL. Overlapping tests are
not added to the local total. Explicit skips are never counted as passes.

## Release-blocking checklist

1. Run authenticated DEV acceptance with disposable records for every role and
   a second tenant, including browser/mobile/RTL/theme/accessibility checks.
2. Establish a bounded live-provider manifest, then validate WhatsApp, voice and
   cross-channel flows one provider at a time. Use only controlled identities,
   recipients and test-mode payments.
3. Configure encrypted off-host backup retention and restore the database plus
   private objects/recordings into a separate destination. Agree DEV and
   production RPO/RTO.
4. Add a registry/container advisory scan and review any actionable findings.
5. Resolve or explicitly accept every P1 in [Findings](findings.md). A release
   cannot use local unit/build success to waive these boundaries.

Completed release gates: PostgreSQL 18.6 migration/RLS execution, supported
Node 24.20.0 pnpm gates, clean reviewed commit, five immutable image builds and
the authorized checksum-bound DEV deployment.

## Provider run manifest status

The user authorized the DEV code deployment, but not provider side effects. No
provider manifest was created because controlled accounts/recipients/spend were
not supplied. Before live acceptance, record:

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

These procedures are contract-tested and the deployment/backup path completed
successfully on DEV. A separate-destination restore and off-host retention are
still production release blockers; a database dump on the same VM is not
disaster recovery.

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

The reviewed candidate is suitable for the current DEV stage and is deployed.
Do not promote it to production yet: authenticated role/device acceptance,
controlled real-provider validation, container advisory review and off-host
disaster recovery remain explicit boundaries.
