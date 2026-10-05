# WhatsApp review of the ProTouch form changes

Local review and repair, 2026-10-05. No provider messages, registration,
subscriptions, customer calls, or deployment were performed by this work.

The reviewed requirements are tenant-scoped templates for Or-On only, and a
real ProTouch web form whose explicit submission opens the service case.

## Repairs

- Template queue admission, catalog reads, automatic-greeting reads/writes,
  and dispatch immediately before the provider attempt check the database
  template policy. The conversation projection exposes `templatesEnabled`;
  a missing value does not enable the UI. The migration enables the policy
  only for the bootstrap Or-On tenant. Test allowances are confined to
  fictional fixture tenants.
- Automatic-greeting publication reauthorizes the same session, user, tenant,
  and exact channel credential binding after all provider catalog reads and
  in the transaction that saves the setting.
- Form follow-up is text containing a generated `/service-request` URL. The
  bearer token is in the fragment and its database record contains a hash.
  The instruction requires the customer to complete and submit the form.
  It contains no fill-in WhatsApp labels and never substitutes a template
  outside the customer-service window.
- Plain WhatsApp replies and incoming media do not submit the form, rewrite
  its answers, or open a case. The legacy plaintext parser and automatic
  case-opening helpers were removed. Pending forms suppress AI extraction,
  automated replies/calls, post-call business actions and media projection;
  previously queued work is cancelled with `digital_form_pending`.
- A verified original caller reopening the service window can resume a
  blocked form delivery. This preserves one canonical follow-up job and its
  outbound idempotency key, handles an initial missing job and an already
  completed blocked job, and checks tenant, channel, contact and the pinned
  voice caller identity. Ambiguous intakes and other identities do not
  receive a link. The case remains unopened until public form submission.

## Local evidence

- `.artifacts/poc-rescue-local/claude-wa-final-focused.log`: 21 tests passed,
  including actual PostgreSQL ingress/worker execution with a recording fake
  provider, both blocked-window resume paths, same-contact wrong-identity
  denial, burst deduplication, unchanged intake answers, no case creation,
  no pending AI work, and policy revocation before provider transmission.
- `.artifacts/poc-rescue-local/claude-crm-verified.log`: 81 files, 756 tests
  passed, zero skips. Unsupported plaintext parser tests were removed along
  with that parser; retained workflow-field validation remains tested.
- Web backend catalog and final authorization boundary: 16 tests passed,
  including changed session/user/tenant/channel after catalog I/O.
- Production worker TypeScript build and worker typecheck passed.
- `.artifacts/poc-rescue-local/claude-wa-full.log`: 71 files, 677 tests passed;
  one existing POSIX symlink test skipped on Windows. Scoped ESLint is clean.

These receipts prove local behavior only. ProTouch provider activation remains a separate
external prerequisite; this review does not claim a live form delivery.

The previously reviewed opening-menu activation-boundary migration was
reconstructed into `.artifacts/recovered_b162a7e4d903_opening_menu_activation_boundary.py`.
It was not added to the active chain or enabled by this work. Its original
additional fixtures were lost during the external branch change and require
recovery and fresh validation before automatic-menu activation.

## Phone-first boundary follow-up

The first standalone WhatsApp service message could still enter the legacy
extractor while the current workflow required a phone-origin digital form.
That created an intake without a voice source and subsequently suppressed AI
as though an issuable form existed. A real PostgreSQL regression reproduced
the unwanted extractor invocation in `claude-wa-standalone-red-actual.log`.

Form mode now prevents legacy text/audio extraction admission, cancels an
already queued extractor before model invocation, and rechecks the current
policy after model completion. Ordinary AI remains eligible when no pending
phone form exists. The reviewed agent draft explicitly treats WhatsApp as a
continuation of an existing phone form and makes no standalone link promise.

`claude-wa-phone-first-final.log` verifies 22 cases, including first-contact
AI continuation, no orphan intake/case, queued-job cancellation, ordinary
non-form intake, a policy flip during model execution, all existing pending
form/reopen cases, OCR and follow-up controls. Its five audio failures were a
pre-existing fixture dependency on another test file having published an
agent. The audio fixture now creates its own fictional tenant/owner/agent;
all five cases pass independently in `claude-wa-audio-independent.log`.
Worker build/typecheck and scoped lint pass. These are local proofs; no
provider messages or runtime configuration changes were performed.
