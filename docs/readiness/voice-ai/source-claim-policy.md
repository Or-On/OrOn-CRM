# Source, claim and action policy

## Evidence classes

| Class                              | May establish business facts?                    | Handling                                                                           |
| ---------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Published tenant source            | Only its currently eligible exact approved facts | Agent-selected source; latest published version; validity and revocation rechecked |
| Authorized backend receipt         | Only the named operation and its actual status   | Server-created tenant/actor/operation/idempotency/resource/time/status             |
| Caller-reported claim              | No                                               | Preserve as a claim; ask or verify through a real supported service                |
| Caller preference/submitted detail | Not external truth                               | Accept explicit address preference; confirm consequential ambiguity before action  |
| Provisional STT                    | No                                               | Keep separate from finalized accepted utterances                                   |
| Previous assistant text / summary  | No                                               | Conversation continuity only, never evidence promotion                             |

The voice runtime exposes conversation routing, not a billing, booking or
customer-verification tool. It therefore cannot confirm those operations.
WhatsApp callback/handoff acknowledgments are rendered from the application's
actual queue/admission outcome. Queued is not connected; failed and unknown are
not success. No mutation follows merely from a caller saying “already paid”.

## Grounded rendering

Voice model output uses a bounded JSON selection protocol. Facts select
`sourceId`, `documentId`, `version`, `factKey`; extra fields and invented IDs are
rejected. The server emits the exact approved value, not a model paraphrase that
could alter 150 into 1,500. Conversation intents produce short fixed replies.
No keyword classifier or self-reported confidence is the final authority.

Selected source IDs are pinned in an immutable agent version. Source status,
latest document version, validity and revocation are live checks. A revoked or
expired latest published version never exposes an older fallback. Different
eligible values for the same fact key cause that key to be excluded. Retrieval
is tenant-scoped and bounded; no second search database is introduced.

Customer messages, retrieved text, quotation, role labels and JSON resembling
tool output remain data. They cannot mint an ActionReceipt. Approved-source
authors must publish general facts rather than customer-specific action claims;
reviewing malicious source content is a release requirement, not model trust.

## Cancellation and limits

The full response is buffered before validation. An interruption clears pending
model/trim buffers, and a generation change during an eligibility read drops the
old reply. Per-call config is pinned, while delivery eligibility is refreshed.
The installed transport cannot certify word-exact remote playback; observations
separate generated/synthesized/submitted text/audio from confirmed hearing.

Voice source reads have a one-second deadline and fail closed. Evidence context
is capped at 12 facts / 6,000 value characters after conflict detection. Response
and session budgets are bounded. Existing provider retry/timeouts and real-send
kill switches remain; no new infinite retries or public endpoints.

Active-call AI control is a durable desired-state command with an epoch and an
idempotency key. The request and the worker acknowledgement are distinct. A
command replay with changed parameters is rejected; pause invalidates local work,
and control loss requires explicit resume. A worker acknowledgement certifies
only the local AI processing boundary, not that previously transmitted speech
was unheard or that a human operator joined. Runtime command history cannot be
silently deleted by ordinary application roles.

This finite policy narrows the attack surface but does not prove arbitrary
published scripts, provider behavior, external effects or every future tool.
