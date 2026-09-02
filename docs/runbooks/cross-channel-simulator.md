# Cross-channel simulator runbook

## Preconditions

Run `make doctor`, `make bootstrap`, and `make db-verify-live`. Confirm
`ENABLE_REAL_TELEPHONY=false`, `ENABLE_REAL_WHATSAPP=false`, and
`ENABLE_REAL_VOICE_PROVIDERS=false` before starting the application.

## Operator proof

1. Sign in with the fictional development account and open **Agents & flows**.
2. Create an agent draft. Its only Phase 6 capabilities are voice and WhatsApp.
3. Publish the agent version; further update/delete attempts must fail.
4. Publish a retained voice composition under **Voice flows**, noting its UUID
   and version. Create a cross-channel flow linked to the agent version with
   that frozen voice reference, CRM company value and fictional message text;
   publish it. Missing references or unsupported paths must be rejected.
5. Choose a completed simulator call and queue the WhatsApp follow-up command.
6. Choose a simulated WhatsApp conversation and queue a call. The command must
   fail until the contact has explicit granted voice consent.
7. Request a handoff, accept it once, and resolve it.
8. Open the contact record and confirm the unified status-only timeline.
9. In **Agents & flows**, choose a conversation and channel under the published
   flow and select **Queue flow simulation**. The contact must have the relevant
   consent. Refresh **Automations** to see `waiting` then `succeeded`; handoff
   appears only after the child job finishes. Failed/expired work must not show
   success. Both messaging worker and control API must be running.

These actions write only canonical PostgreSQL records and simulator jobs. They
must not result in telephone, Meta API, webhook, trunk, DID, or provider changes.

## Verification

```bash
make migration-check
make db-verify-offline
make db-verify-live
make verify
```

The database must report sole head `50a6befe7903`. Replaying a workflow with the
same idempotency key returns the existing job. Two concurrent handoff accepts
must produce exactly one assigned user.

## Failure handling

- `voice consent is required`: update consent only from an authorized contact
  workflow; never bypass the check.
- `terminal contact-linked call outcome is required`: use a completed retained
  simulator session associated with a canonical contact.
- publish rejected: publish a valid agent version before its linked flow.
- provider flag guard: stop and restore all real-provider flags to `false`.

## Updating an existing localhost installation

Do not re-run bootstrap/seed just to update code; that is unnecessary for these
successor migrations. Stop the host development runner, apply `make migrate`
(Windows: `uv run python scripts/dev.py migrate`), then restart with
`uv run python scripts/dev.py dev`. Before restarting a worker with real WhatsApp
enabled, review outstanding real jobs: restarting can resume previously approved
sends. This acceptance run deliberately did not restart the user's dev workers,
rewrite `.env`, or reset the development login. Its tests used disposable databases.

For isolated worker acceptance set `CROSS_CHANNEL_TEST_DATABASE_URL` to an explicit
localhost migration connection, build `@or-on/crm`, and run
`pnpm --filter @or-on/messaging-worker exec vitest run tests/call-followup.live.test.ts`.
This creates/seeds/removes only its own UUID-named database, never the dev queue.
