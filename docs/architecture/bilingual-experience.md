# Bilingual product experience

Implemented 2026-09-03 on `codex/phase-7-ui-polish`, extending clean baseline
`0408d5274af3c181aef32ec79352abfba1ed14be`. No database revision or provider engine
was added. The [audit, sitemap and journeys](../plans/phase-7-bilingual-redesign.md)
define the actual product scope, including deliberately absent commercial/auth flows.

## Locale ownership and routes

- `apps/web/src/i18n/messages/en.json` and `he.json` own presentation copy. Tests
  require matching namespace/key sets, matching ICU arguments and successful
  formatting of every message in both dictionaries. Customer-authored content,
  provider/template names, identifiers and technical payloads are not translated.
- Existing next-intl 4.14.1 supplies server/client ICU messages. `request.ts`
  selects one dictionary, not both, for the provider. Error-label allowlists also
  recognize known local strings from both languages so retained errors translate.
- `proxy.ts` overwrites untrusted locale headers, validates `en`/`he`, and selects
  the public URL locale or an HTTP-only preference cookie. This is presentation
  metadata, never authorization or tenant context. Root layout renders real
  `html lang` and `dir`; no CSS transform mirrors the document.
- Public routes `/en` and `/he` use localized title, description, canonical,
  language alternates and social metadata. `PUBLIC_SITE_URL` must be an explicit
  HTTP(S) origin without credentials, path, query or fragment. Development pages
  are noindex. Public launch still requires approved legal/operator information.
- Workspace URLs stay stable. The language action updates the cookie and refreshes
  server content in place, preserving the mounted Inbox draft and conversation.
  Theme changes also leave draft state intact. Tenant changes intentionally reset
  workspace context. Public language changes use document navigation to the same
  localized path, query and fragment; this avoids a Next shared-layout cache mixing
  new server copy with an old client dictionary. The illustrative tab resets on
  that public navigation; no business form is present on those routes.
- `ProductHeading` and `productMetadata` standardize working-page hierarchy.
  Global error recovery uses an explicit bilingual emergency message because the
  localization provider itself may be unavailable.

## Visual/component contract

The signature is **conversation continuity**: a small number of connected steps,
readable channel state and a clear next action. Marketing's three-step example is
labelled fictional, not fake live activity. No invented metrics, testimonials,
customer logos, prices or certifications are published.

Reuse `packages/ts/ui` semantic graphite/mint tokens, refined light surfaces,
Button, Input, Surface, Badge, Skeleton, Empty/Error and native Dialog. Existing
Latin/Hebrew-capable system fonts avoid a font download and preserve platform text
scaling. Working views use compact headings and useful density; marketing has a
larger narrative hierarchy. CSS uses logical spacing and intrinsic grids. Numbers,
phones, email, code and identifiers use direction isolation where appropriate.

The desktop rail can collapse without losing accessible names. Mobile keeps a
direction-aware menu and separate conversation-list/thread navigation. The command
palette supports search, Arrow keys, Enter and Escape. Dialogs use native modal
focus containment; `data-dialog-initial-focus` nominates the palette search input.
Only directional icons mirror. Existing reduced-motion rules remove nonessential
transitions. No animation/motion/chart dependency was added.

## Data and interaction corrections

- Inbox: retained race/abort/idempotency/provider safeguards; translated receipts,
  sender/recipient review and explicit real-send confirmation. Unsent text remains
  conversation-scoped across workspace language changes.
- Contacts: failed notes/forms retain input; CSV imports show created/skipped and
  safe row feedback while keeping partial imports editable. Numeric/boolean/date/
  multi-value custom fields submit the intended JSON types. Choice catalogs are
  not yet exposed by the existing field contract; no invented options are shown.
- Pipelines: select any returned board. Sum exact decimal strings using integer
  arithmetic and show separate locale-formatted totals per currency. No implicit
  exchange rate or USD assumption. Existing stage APIs remain authoritative.
- Automation: the PostgreSQL read model classifies empty, canonical and unsupported
  definitions; each UI offers actions for the appropriate existing executor. This
  classification is presentation guidance, not validation or a new engine.
- Activity: localized domain/status headings, selectable contact scope, timestamps
  in the current locale, original event codes/payloads under technical disclosures.
- Management: actual real-provider configuration replaces unconditional simulator
  copy. Secrets are never forwarded in the page props. Permission-aware fieldsets
  supplement, but never replace, server RBAC/RLS.
- Feedback: native validation is localized; recoverable async errors use safe
  allowlisted messages. Background health checks preserve the previous content;
  readiness requires the real readiness response as well as PostgreSQL state.
  Browser-offline status is labelled as connectivity, not server readiness.

## Boundaries and remaining acceptance

Authentication/session/CSRF/RLS, durable jobs, consent and provider kill switches
are retained. No default flag was enabled. No source-engine files were copied.
OpenLive, cloud deployment, final auth-framework expansion and real provider
smokes are excluded. See the [acceptance record](../runbooks/bilingual-ui-acceptance.md)
for executed checks and the explicitly outstanding matrix. Do not turn a tested
build or dictionary parity check into a claim of full accessibility or production
readiness. Cross-route unsaved-form warnings and a full field-option editor remain
follow-up refinements, not implemented features.

Authoritative implementation references: bundled Next.js 16.3.3 documentation and
[next-intl App Router setup](https://next-intl.dev/docs/getting-started/app-router/without-i18n-routing),
[server/client environments](https://next-intl.dev/docs/environments/server-client-components).
