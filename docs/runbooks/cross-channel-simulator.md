# Cross-channel simulator runbook

## Preconditions

Run `make doctor`, `make bootstrap`, and `make db-verify-live`. Confirm
`ENABLE_REAL_TELEPHONY=false`, `ENABLE_REAL_WHATSAPP=false`, and
`ENABLE_REAL_VOICE_PROVIDERS=false` before starting the application.

## Operator proof

1. Sign in with the fictional development account and open **Agents & flows**.
2. Create an agent draft. Its only Phase 6 capabilities are voice and WhatsApp.
3. Publish the agent version; further update/delete attempts must fail.
4. Create a cross-channel flow linked to that published version and publish it.
5. Choose a completed simulator call and queue the WhatsApp follow-up command.
6. Choose a simulated WhatsApp conversation and queue a call. The command must
   fail until the contact has explicit granted voice consent.
7. Request a handoff, accept it once, and resolve it.
8. Open the contact record and confirm the unified status-only timeline.

These actions write only canonical PostgreSQL records and simulator jobs. They
must not result in telephone, Meta API, webhook, trunk, DID, or provider changes.

## Verification

```bash
make migration-check
make db-verify-offline
make db-verify-live
make verify
```

The database must report sole head `a1a71d1f7a03`. Replaying a workflow with the
same idempotency key returns the existing job. Two concurrent handoff accepts
must produce exactly one assigned user.

## Failure handling

- `voice consent is required`: update consent only from an authorized contact
  workflow; never bypass the check.
- `terminal contact-linked call outcome is required`: use a completed retained
  simulator session associated with a canonical contact.
- publish rejected: publish a valid agent version before its linked flow.
- provider flag guard: stop and restore all real-provider flags to `false`.
