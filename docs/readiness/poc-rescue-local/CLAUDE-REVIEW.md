# ProTouch digital intake and Or-On templates — October 5, 2026

The reviewed change replaces the earlier WhatsApp text-reply intake with the customer's requested web form. Fault descriptions are free text, following the user's clarification. Only the existing Or-On tenant is enabled for WhatsApp templates; other tenants, including ProTouch, default to denied. UI visibility, API authorization, queue admission, and provider dispatch enforce that policy.

## Accepted behavior

1. The ProTouch telephone agent captures only the customer's name and fault/service description. It cannot confirm the intake, open a case, or use an emergency/inquiry tool to bypass the form. A queued link request is not described as delivery.
2. With consent and an open WhatsApp customer-service window, the worker sends a private, expiring URL. The bearer token is hashed in the database and kept in the URL fragment. The form needs no CRM login and shows the appropriate tenant's business name.
3. The customer can edit the name and free-text fault, enters a location, optionally uploads photos under ProTouch's `requested` photo policy, and explicitly confirms submission. The server validates the token, active tenant and features again, bounds uploads and field lengths, and confines attachments to that tenant and intake.
4. Only this submission creates the case, related ticket, location and attachment records. Retries and simultaneous submissions return one case reference. Calls, WhatsApp text, raw media, and draft capture cannot finalize it. Visible, idle service lists refresh every five seconds without overwriting edits.

If a transaction's commit acknowledgment is lost after photo promotion, the server preserves the private photos and checks the durable receipt. It never deletes photos that may belong to a committed case. A genuinely rolled-back transaction with an unknown acknowledgment can leave private unreferenced files; reconciliation remains an operational limitation, not a second case or a public object.

## Review evidence

- Voice capability/prompt and SQL admission tests exercise name plus fault, no extra telephone questions, truthful unavailable/queued replies and prohibition of early cases.
- The final focused PostgreSQL run passed 67 tests covering cross-tenant/expired tokens, feature revocation, missing consent, photo bounds and ownership, concurrent submission, atomic rollback, role permissions, template denial, online/offline migration parity, and refusal to falsely downgrade a forward-only submission receipt migration. It also covers 160/161/500-character locations without merging distinct addresses, recovery from a closed messaging window, and refusal to describe completed jobs as newly queued.
- The complete CRM suite passed 756 tests. The worker suite passed 677; one POSIX symlink test is unsupported on Windows. The new service-form worker integration test is explicitly included in CI's real PostgreSQL cross-channel job.
- The full web suite passed 1,017 tests before the final visible-refresh/branding changes. Focused refresh tests passed 39 and the final form/API/settings group passed 57. Pagination remains expanded until the user explicitly returns to latest records. Workspace formatting, lint, all 11 typechecks and production build passed. Other TypeScript packages passed 108 tests without skips. These counts are not presented as a deployment check.
- A real local browser, backed by an isolated PostgreSQL database and restricted web role, submitted a fictional form with a photo. Reload preserved reference `FS-2026-DB6D15DA`. Readback found exactly one case in `awaiting_scheduling` and one available private photo whose bytes and SHA-256 matched storage metadata. The owned preview database and role were removed afterward.
- Form layouts at 320, 375, 390, 430, 768, 1366 and 1920 pixels had no horizontal page overflow. Screenshot receipts and bounded readback are in ignored `.artifacts/digital-form-preview/`; they contain only fictional test data.

## Deployment and provider boundaries

These source and local-test receipts do not establish a live deployment. The release must pass exact-commit Main CI, then `scripts/deploy_gcp_manual.py` verifies and deploys immutable images to the existing GCP machine. Tenant drafts must subsequently be published through normal reviewed application APIs; configuration JSON files do not activate themselves.

ProTouch's number remains registered in the phone's WhatsApp Business application. Its Cloud API sender was pending at the last provider inspection. The user requires keeping that application and declined a new provider subscription or Tech Provider signup. This change does not remove that external activation blocker. It also cannot initiate a free-text WhatsApp link outside an open service window while templates are forbidden for ProTouch. No deregistration, subscription, provider workaround or test message is implied by the code release.

Migration `e9c5b8d2a401` is forward-only: retain its schema when rolling back compatible application images. Before restoring a pre-form application, restore the prior reviewed tenant workflow configuration; do not re-enable the old plaintext intake path accidentally. The missing, separately planned legacy opening-menu activation remains held; the recovered ignored copy is not treated as an approved migration.
