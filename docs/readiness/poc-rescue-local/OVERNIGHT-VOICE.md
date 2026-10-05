# Overnight voice audit and minimal ProTouch intake

Evidence is separated into live readback, local execution, prepared operations, and unverified acceptance. No telephone call or customer message was placed during this overnight work.

## Effective agents on the last audited live release

The read-only audit used actual deployed `bdaa5a3244c68cc6ba1d043807d4220bb62a12c1`, schema `af54b6c13e92`, normal CRM owner APIs, and the compiled dispatcher's tenant-scoped resolver. Only two active tenants were found.

| Tenant | Effective approved agent | Effective retained script | Latest retained script | Evidence |
| --- | --- | --- | --- | --- |
| Or-On | v4, `072b9420-8f25-479f-a785-6a57dafd1120` | v1 | v3 | Both inbound and outbound resolver paths, UI quality binding and approved processes |
| ProTouch | v1, `9a9bfdbf-4c46-4bd4-842f-2bfb8c4cb173` | v1 | v1 | Both inbound and outbound resolver paths |

Or-On's other five profiles are archived. Agent v4 is approved for voice and WhatsApp and selects one published knowledge source/revision. ProTouch has no selected knowledge source. Both audited compiled voice paths use Hebrew/female configuration, Gemini 2.5 Flash, Soniox `stt-rt-v5`, and Soniox `tts-rt-v2`/Harper. Model configuration rows are absent; these choices come from the reviewed runtime settings, rather than a tenant-specific model row. Prompt/knowledge hashes were recorded without customer text or secrets.

Private/local receipts under `.artifacts/poc-rescue-local/`:

- `overnight-voice-inventory.json`
- `overnight-voice-resolver.json`
- `overnight-oron-script-comparison.json`
- `overnight-oron-script-behavior.json`
- `overnight-oron-script-preflight.json`

## Or-On stale script and preparation status

Published retained v3 contains substantive behavior changes: a Hebrew greeting, concise support/sales knowledge use, one question at a time, no unnecessary phone collection, ticket claims only after a tool receipt, and an explicit goodbye/end action. It is not merely a larger version number. Current shared canonical v1 still pins retained v1 and also contains unrelated demonstration actions used by the existing WhatsApp flow.

The proposed replacement is a separate voice-only `start -> voice.call -> end` canonical, using the existing approved agent v4 and retained script v3. The normal tenant-configuration proposal preserves all feature settings and the WhatsApp process, changes the outbound voice process to the new canonical, and adds one inbound voice process with the same agent and priority. Normal approval recreates process row IDs; it preserves process configuration values, not row identities.

`poc_oron_voice_publish_remote.py` passed a normal authenticated dry-run with zero domain mutations. Its journaled create/publish/draft/submit/approve path is held for root review and a repaired live source. Configuration v9/revision3 was read back; before hash `bef680d5d5302135f0fceaba73fec63ff425485cc713f936022b1345f31a7ff2`, placeholder proposal hash `88be955960be5475167538919ffbcdf3f8d79570d15b3a61cb1ea7007f5bf6f8`. No agent/script/configuration was republished overnight.

A resolver defect was fixed in commit `9e76540`: rank the latest approved canonical before filtering matching voice nodes. Explicit approved process/admitted-version pins remain stable. Actual PostgreSQL verification: **22 passed**, no skips. The web real-call API separately failed to honor that approved outbound process and could treat old WhatsApp/shared and new voice bindings as ambiguous; the UI agent repaired that route with real `platform_web` PostgreSQL tests. Live publication remains gated on its deployment and exact three-process payload validation.

## Or-On inbound preparation, held without provider writes

The owned source number ends `5689`; its existing carrier origination remains `sip:34.165.20.227:5060`, and its database DID binding remains the simulator marker. ProTouch's activated digest callback and both outbound identities were preserved.

Plan `oron-inbound-17a4c1af7ed244b39a31ca2426ea997e` prepares one distinct Or-On digest trunk/rule and appends an isolated callback route. No new subscription, phone number, public SIP server, or human call is involved. Provider-only preparation keeps the existing approved v4/script1 binding while the DID is quarantined. Activation separately requires approved v4/script3 plus the repaired CRM selector.

A new distinct secret and full provider baseline were securely staged root0600 under `/opt/oron-dev/oron-inbound-private-17a4c1af7ed244b39a31ca2426ea997e`; active configuration was not changed. The bdaa/af preparation gate verified healthy exact images, zero active calls/provider rooms, original simulator marker, unchanged ProTouch callback, and both outbound routes. Offline SDK serialization and duplicate-binding rejection checks passed.

The first provider-stage attempt stopped **before its first create or journal operation**. Diagnostic readback identified equivalent ordering differences in Twilio's `auth_type` and `auth_type_set` (`IP_ACL,CREDENTIAL_LIST` versus reversed order). The strict comparison was not bypassed. No Or-On trunk/rule was created, and no provider, runtime, DID, or carrier-route mutation followed. Subsequent user work put provider operations on hold. A later reviewed normalization may compare these explicit sets; do not silently re-run the operation or claim inbound activation.

## ProTouch's revised telephone contract

The latest instruction supersedes Claude's uncommitted form behavior. Its previous implementation skipped the fault, allowed full intake and confirmation over the phone, created an empty draft to send, promised WhatsApp delivery, and fell back to collecting all details when the channel was blocked.

The corrected voice implementation now:

- Exposes and accepts only `customerName` and `faultDescription` in form mode, always with `confirmed=false`.
- Requires both facts to have a durable intake receipt before requesting the server-owned web form link. Failed/empty saves cannot unlock sending.
- Requires a `queued` receipt containing the matching intake ID and a job ID; deferred, unavailable, mismatched, or unexpected case/ticket receipts do not license success.
- Says only that the request is queued and delivery is unconfirmed. A case requires the customer's explicit web form Submit action. A WhatsApp reply, consent, a draft, or a link request does not open it.
- Keeps form-only rules when WhatsApp is disabled. It explains that staff follow-up is needed without claiming notification or a promised callback, and never falls back to full telephone intake.
- Suppresses early inquiry/emergency creation in form mode, removes that tool, rejects direct photo fallback, and retains the generic ticket-tool exclusion for a service-intake agent. The ProTouch draft grants only `service.intake`.
- Removes the broad speech-safety exemption based merely on having the WhatsApp tool; unverified delivery promises remain blocked in Hebrew and English.

The nonsecret agent reference was corrected from the wrong Or-On caller/trunk to ProTouch `4553`, `protouch-9376.pstn.twilio.com`, and existing outbound `ST_Dc2P469Pn2ZU`. The file remains a reviewable draft, not a runtime activation mechanism. Root owns the corresponding SQL, public web-submit, and worker enforcement.

Validation:

- Full provider-free agent suite before six additional negative receipt tests: **1093 passed, 16 gated model evaluations skipped**.
- Final focused service-intake, spoken-safety and grounding suite: **113 passed**, no skips.
- Actual PostgreSQL voice bridge on fresh schema `e9c5b8d2a401`: **23 passed**, no skips. Six added cases verify SQL enforcement with form delivery enabled and disabled, arbitrary Hebrew free-text fault persistence, early inquiry/emergency/generic ticket denial even with `ticket.open`, unavailable-window truthful agent output, and one idempotent durable queue job with zero cases/tickets. Log: `.artifacts/poc-rescue-local/protouch-form-voice-db.log`. The isolated UUID database was removed; existing data was untouched.
- Scoped Ruff check/format and targeted Pyrefly: pass / zero errors.
- No real-provider or human acceptance claim is made for this new intake behavior. It is not yet published/deployed; WhatsApp delivery remains blocked under the preserved phone-app constraint.

The earlier human-confirmed ProTouch Hebrew outbound conversation, parser RTC proof, pending human incoming test, and unsuccessful later outbound regression retain their separate receipts in `VOICE.md`. They do not establish acceptance of this new form flow.

## Digital-form boundary peer review

The new `e9c5b8d2a401` schema and public submit path were reviewed against actual PostgreSQL roles. The review found that an existing bearer link could still expose intake details after tenant suspension or ticket-feature revocation. Issue/read/submit now recheck the active tenant and current field-service/ticket features. Field-service uses its established canonical switch in `service.tenant_configuration`; its entitlement's legacy `enabled` column does not control this feature. Link issuance also requires WhatsApp eligibility.

Photo metadata now rejects missing, null, or wrongly typed required fields, non-integer/oversized lengths, foreign tenant/intake keys, traversal, unsupported media, duplicate storage keys, and total uploads above 20 MiB. These checks run before submission state changes. The public HTTP layer independently validates the actual image bytes and generates private storage keys. Its repaired commit-ambiguity path preserves potentially committed files until the result can be reconciled; an unresolved outcome may leave private orphan files and is not proof of automatic cleanup.

Actual local verification: **61 passed, zero skips** across the digital-form boundary and voice bridge (`digital-form-peer-final2.log`). This includes an attachment insertion failure after case creation rolling the complete transaction back, two actual connections contending on one form and producing one case/ticket/reference, and offline Alembic SQL applied to a fresh predecessor database. The migration now explicitly refuses downgrade; the test proves the schema version stays at e9 and guarded submission still works. Compatible application rollback retains the new database schema. No production migration or customer delivery is claimed by these tests.

The bearer-authorized read also returns the bounded same-tenant business name, with a tenant-name fallback, so ProTouch's public form can display its own identity. The reviewed agent publication fixture now expects only `service.intake`, matching the deliberate removal of `ticket.open` before explicit form submission. The WhatsApp agent's independent full CRM run picked up this assertion: **756 passed across 81 files, zero skips** (`claude-crm-verified.log`). Root owns the web/worker release and its live activation.
