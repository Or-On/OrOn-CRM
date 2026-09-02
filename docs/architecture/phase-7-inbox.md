# Phase 7 Inbox read model and interaction boundary

This is a UI/read-model change, not a provider or schema replacement. No migration
was added. All sources in this checkpoint are new platform-owned code or edits to
existing target code; no upstream artifact was copied or substantially adapted.

## Tenant-owned reads

Overview counts query the full RLS-visible sets, not the capped navigation list.
Conversation summaries expose the channel provider, configured sender identifier,
validated recipient and consent status. They never return credentials. An exact
conversation lookup supports following a provider-admission destination outside
the latest 100 conversations. List search intentionally covers only loaded rows;
server-wide search and conversation pagination remain future work.

`GET /api/messaging/conversations/:id/messages` returns `MessagePage` from the
shared TypeScript CRM contract. It reads the latest 50 rows, displayed in ascending
order, and returns an optional `nextCursor` for older rows. `before`/`beforeId`
must be supplied together. Ordering is `(created_at, id)`. Cursor timestamps
retain six fractional digits and bind as **text before PostgreSQL casts them to
timestamptz**: a driver Date conversion otherwise loses microseconds and skips
rows. Existing `listMessages` callers receive the latest 250 chronologically.
The live test includes tied timestamps and checks the entire 303-row history.

Template display whitelists name/language/body parameters from structured content;
it is a submitted reference, not synchronized Meta approval or rendered wording.
The Python OpenAPI contract is unchanged and generated-client freshness passes.

## Interaction safety

- A thread is keyed by conversation ID. Obsolete reads are aborted and late
  responses ignored. Responses for another conversation are rejected.
- Drafts and reply-intent keys live only in React memory, scoped to a workspace
  instance and conversation. Tenant switching remounts workspace content. A page
  reload does not preserve a draft or uncertain request key; do not blindly retry
  a real send after reloading. Durable server idempotency remains authoritative.
- The same recipient/sender/provider/content intent reuses its key after a failed
  request. Successful queue admission clears it. Failed list refreshes cannot be
  presented as failed admission or invite a second send.
- Real delivery defaults off, requires the checkbox plus a sender/recipient/content
  review, and rechecks the flag at the UI submit boundary. Changing a draft resets
  confirmation. Server RBAC, consent/window rules, idempotency, and provider kill
  switches remain the authority; hiding buttons is not authorization.
- Polling is per-thread at five-second intervals and pauses while older history is
  open. The latest conversation list has an explicit refresh control.
- Technical/demo controls are disclosures. Queue, delivery, simulation, configured
  sender ID, and provider approval are labelled separately.

## Acceptance boundaries

React DOM interaction tests use mocked transport only. Desktop Overview/Inbox were
visually inspected in an isolated browser preview in dark/light themes with a
fictional account. Responsive styles exist but the full mobile/tablet/zoom matrix,
keyboard audit, actual Hebrew translations, and performance measurements remain
P7-008/P7-009 gates. Do not call Phase 7 complete on this checkpoint's evidence.
