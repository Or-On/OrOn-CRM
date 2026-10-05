# LiveKit durable replay schema compatibility

Status: VERIFIED_LOCAL. Deployment and a new real provider callback remain separate gates.

## Observed failure and exact reproduction

On deployed source `0f003ccd0049e6c2b0bc8f19e17a80d7f339e198`, one outbound call ended unanswered and its session/artifact pointers were persisted. Its later `room_finished` receipt exhausted eight dispatcher attempts. This did not establish an outbound trunk regression or a failed session write.

The read-only probe of the exact retained event inside the deployed dispatcher image established the cause: strict `ParseDict` raised `ParseError` for the additive top-level `roomEndReason` field, while `ignore_unknown_fields=True` succeeded. No event handler, provider operation, session finalization or ledger update ran in that probe. The existing LiveKit SDK receiver already uses the permissive policy after verifying the JWT and raw-body hash, so durable replay had applied a different schema contract to an authenticated body.

Private evidence is kept outside Git:

- `.artifacts/poc-rescue-local/protouch-room-finished-diagnostics.json`: eight attempts and the original terminal receipt.
- `.artifacts/poc-rescue-local/protouch-room-finished-parse-only.json`: exact-image parse result and field names/types only; no payload values.
- `.artifacts/poc-rescue-local/livekit-schema-red-actual.log`: three positive/known-binding cases failed before the repair; two malformed-known-field negatives passed.
- `.artifacts/poc-rescue-local/livekit-schema-green.log`: 95 passed, zero failed/skipped after the repair. The only warning is the existing Starlette/httpx test-client deprecation.

## Repair and boundaries

Durable replay now matches the SDK receiver's unknown-field policy. The original signed JSON stays in the ledger: a second receipt with the same event ID but changed unknown fields remains a collision and is rejected. Known protobuf fields still undergo the SDK's normal type validation; SIP kind, current-participant, authoritative DID/rule, tenant and trunk admission checks remain in the actual dispatcher.

Unexpected handler failures now log only the exception class in the formatted message, making it visible with the deployed text formatter. Exception messages, tracebacks and provider payloads are not included.

There is no schema migration, session-finalizer change, provider change, manual replay or historical settlement rewrite in this repair.

## Verification

The new PostgreSQL fixture uses fictional data, actual `platform_voice` role, signed HTTP ingress, the real ledger/pump and real Dispatcher. It verifies unknown top-level and nested fields, a completed room, valid inbound admission, foreign-trunk quarantine, one-attempt settlement, raw JSON retention, unchanged duplicate finality and changed-payload rejection. Known malformed numeric fields are rejected both at signed ingress and when deliberately injected into the isolated replay fixture; no handler executes for them.

The 95-case run also includes existing dispatcher lifecycle/finalization, signature, cancellation, expired/replaced claim and quarantine tests. Ruff, `git diff --check` and explicit dispatcher-source Pyrefly passed. An independent reviewer cleared the source and actual-PG proof, and separately passed four signature, duplicate, shutdown and safe-logging cases.

The isolated database and its child fixtures were removed after each run; no original development or production data was modified.
