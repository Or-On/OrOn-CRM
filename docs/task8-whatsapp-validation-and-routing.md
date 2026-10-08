# Task 8: WhatsApp recovery, locale and callback routing

Local feature branch: `codex/whatsapp-locale-callback`, based on reset commit `ac0d00a`. No production data, customer provider traffic, server start or deployment was used.

## Behavior

- The reviewed agent configuration optionally pins `phoneRegion: "IL"`; the reset manifest supplies it. Agent create/revise BFFs reject unsupported regions. Omitting the field on a revision preserves an existing reviewed region. Response language never supplies a dialing region.
- Both TypeScript and Python use the same generated lead contract. Israeli national shapes come from the installed `phonenumbers 9.0.38` IL general-description metadata; this checks possible numbering shapes, not whether a subscriber exists. Local numbers and bare `972…` normalize only under IL. Explicit malformed `+9720…` is rejected before generic E.164 handling. Other international country codes remain supported.
- `LeadFieldValidationError` has a distinct recoverable action receipt containing a stable code and field, without the raw value. An invalid phone delivers **אפשר מספר טלפון תקין לחזרה?** through the normal outbound validation path. That turn stops after the rejected action. A multi-field batch is atomic: an invalid phone does not claim that its accompanying name was saved; accepted message history retains the volunteered name, and the correction saves it once. Earlier committed service facts survive.
- One server-side locale resolver handles current and historical inbound evidence. Dana, dana, hi, repeated greetings, phone/email/URL input and multipart names are neutral. Explicit language requests take priority. Otherwise English requires at least three distinct meaningful Latin words and sentence evidence, with no Hebrew. The preceding delivered question can identify a name answer but cannot choose the response language. Server-resolved locale is stored with `customer-language.v2` provenance and retained across neutral replies; previous assistant text and CRM display labels never establish language.
- Ordinary callback intent reaches the published lead-capable agent. `follow_up_allowed` is saved from the current accepted request when that reviewed schema defines it. Supplied facts remain available to the agent. A model cannot turn this into `request_call` or an immediate handoff. Missing schema is an explicit error. Without effective `lead.write`, an actual human handoff receipt is required. An immediate request for a person bypasses the model questionnaire. Automatic telephony requires separate, explicit AI/automated-call wording and the existing authorized workflow.
- Explicit callback refusal cannot trigger a call or model-authored side effect; an existing lead records withdrawal of `follow_up_allowed`. Callback phone capture never changes the verified WhatsApp identity.
- Instruction hash metadata from the shared composer is persisted on each physical model attempt, including attempts without provider token details. This feature branch supplies the persistence fields; the integration branch owns the composer and spool implementation.

## Evidence and reproduction

Use Node 24 from the existing local runtime. PostgreSQL tests require an explicit local `CROSS_CHANNEL_TEST_DATABASE_URL`; the owned acceptance server on loopback 55480 was used. Each suite creates and removes a UUID database, migrates it, seeds fictional fixtures, and runs web and worker operations as `platform_web` and `platform_messaging`. Fake Meta accepts sends without network traffic. Webhooks use real HMAC signing and the real ingress/worker/delivery path.

Commands executed:

```text
pnpm --filter @or-on/crm build
pnpm --filter @or-on/messaging-worker typecheck
pnpm --filter @or-on/crm exec vitest run src/lead-schema.test.ts src/lead-contract.test.ts src/cross-channel.test.ts src/execution-contract.test.ts
pnpm --filter @or-on/messaging-worker exec vitest run tests/task8-callback.live.test.ts tests/simple-enquiry.live.test.ts tests/lead-capture.live.test.ts tests/ai-reply.live.test.ts src/task8-locale.test.ts src/ai-grounding.test.ts
pnpm --filter @or-on/web exec next typegen
pnpm --filter @or-on/web exec vitest run tests/orchestration-management-api.test.ts
python -m pytest packages/py/oron-agent/tests/test_lead_capture_contract.py -q
python scripts/generate_lead_contract.py --check
```

Focused CRM tests: **252 passed**. Grounding/locale: **302 passed**. Existing discovery/lead integration: **5 passed**. Automatic AI-call integration: **1 passed**, after updating its positive fixtures to explicitly request an AI call and matching the new deterministic refusal wording. BFF revision tests: **6 passed**. Python shared phone/lead parity: **81 passed**. Worker typecheck, changed-file ESLint, Python Ruff lint/format and generated-contract freshness passed.

The new signed-webhook suite: **16 passed**. It checks complete valid numbers, bare `050` correction, name plus invalid phone atomic rejection, worker loss after a committed name save and retry, volunteered name/phone in callback text, lead capability present/absent/read-only, immediate human request, negation, quoted/conditional wording and missing schema. Completed conversations have one lead in the human review queue, one finalization event, a Hebrew closing after commit, unchanged transport identity, zero automatic-call jobs and no unintended ownership transfer. Duplicate webhook replay adds no send, provider call or lead.

The added locale sequence delivers fourteen turns with one identical provider timestamp: Dana, a multipart name, greetings, substantive English, phone/email/URL input and explicit Hebrew/English switches. It verifies the delivered text and persisted locale on each turn. History now uses trusted webhook receipt ordering, matching the current-trigger guard, so provider second precision cannot move a name answer before its preceding question. A substantive English sentence still switches language even after a name question. The same PG case invokes the physical-attempt callback with synthetic hashes and no token details; every attempt has one joined model-attempt/audit record with the same event ID, tenant, agent version, job, static/runtime hashes, effective locale and composition version. Exact metadata assertions exclude customer text and fabricated usage details. These hashes prove persistence, not the integration branch's composer equality.

Synthetic delivered transcript (valid case):

```text
Customer: אפשר מידע על סוכן וואטסאפ לעסק?
Agent: איזה סוג של פניות מגיע לעסק?
Customer: תחזרו אליי
Agent: מה השם שלך?
Customer: Dana
Agent: באיזה מספר אפשר לחזור אליך?
Customer: 0501234567
Agent: תודה, נפתח ליד במערכת עם הפרטים שמסרת. נציג אנושי של OrOn יחזור אליך בהקדם.
```

The stored callback is `+972501234567`; the fixture sender remains its separate fictional transport identity. In the invalid-prefix variant, `050` produces the Hebrew correction prompt before the complete number is supplied. This is deterministic fake-provider execution evidence, not evidence of LLM semantic quality or live Meta delivery.

## Failures retained and limits

Before the locale fix, **7 of 15** focused regressions failed (Dana/dana/hi/repeated greetings/multipart name, historical name and the explicit Hebrew request for English). The follow-up name-context regression failed for `I need help`, and the rapid-turn PG case reproduced a wrong English locale for `Will May Need` before receipt ordering was fixed; both now pass. Existing tests initially expected ordinary callback wording to launch telephony and expected an immediate human request to run lead collection; these expectations were changed to the owner's new semantics while keeping queue, ownership and deduplication assertions. The discovery fake provider also needed to read the already-persisted follow-up permission rather than treating its absence as a prerequisite for recording the remaining discussion facts. A volunteered-name fixture initially referenced the invalid-batch message instead of its current accepted message; the fixture reference was corrected.

This report does not claim live deployment, real Meta receipt, human audio acceptance or browser/mobile inspection. Task 6/7 integration, composer/runtime equality, full release verification and release authorization remain the integration owner's gates. The reviewed region must be included in the actual reset plan; a local manifest is not an activated production configuration.
