# Application-only UI rebuild — 8 September 2026

## Current scope

The user's latest direction supersedes the earlier landing-page brief: inspect
[or-on.io](https://or-on.io/), remove the landing page, and retain the working
application. Follow-up requests explicitly include premium presentation, precise
layout alignment, and small-icon alignment. Root and scoped instructions apply;
the referenced `BOOST.md` was not present in this workspace.

The reference was inspected as rendered desktop and mobile pages, including its
architecture section. Its midnight navy, electric-blue interaction accents,
fine technical grid, restrained motion and clear typography inform the new
presentation. No reference assets, copy, source code or exact layout were copied.
This is a visual direction, not a claim of feature parity with the reference.

## Implemented presentation

| Area | Current treatment |
| --- | --- |
| Entry | Guests enter `/login`; `/en` and `/he` preserve the chosen language and redirect to login or the authenticated overview. Active marketing/Gateway Flow components and styles are removed. Historical attribution is retained. |
| Authentication | New original technical identity composition, existing login form/session behavior, bilingual help and authenticated `/start` onboarding. No self-registration route existed; no fake signup workflow was added. |
| Workspace | Compact primary rail, command header, contextual navigation, mobile drawer, tenant/account controls and working command palette. Account dismissal handles outside clicks, navigation and Escape without stealing outside focus. |
| Overview | Actual PostgreSQL-backed conversation and relationship metrics, attention queue, recent conversations, separate currency totals and explicit channel state. No fabricated charts, trends or delivery claims. |
| Inbox | Two-pane conversation workspace with independent scrolling, contact context on demand, bounded composer, legible status/history, retained filters and draft/confirmation behavior. |
| Customer records | Searchable directory and creation surface; record profile/permissions and activity/notes/fields stack independently rather than leaving artificial grid-row gaps. Two columns persist to the tablet breakpoint. |
| Pipeline and operations | Real stage distribution, opportunity board, campaign/automation indexes and run records. Existing empty-state actions open the existing setup forms. |
| Agents, settings, voice | Domain-owned layouts, aligned setup fields/action rows, explicit unavailable states, preserved permission and provider boundaries. OpenLive remains deferred. |

Shared tokens provide dark/light surfaces, Geist/Noto Sans Hebrew typography,
consistent spacing, reduced-motion behavior, visible focus and semantic status
colors. Redundant prior public/shell styles and conflicting form padding were
removed rather than leaving another full override layer.

### Alignment and icon review

- Common page gutters; top-aligned independent content rails; intentional
  responsive collapse and safe long-name/currency/timestamp wrapping.
- Header controls share a 44px height. Shared icon buttons are square: 40px
  medium and 32px small. Inbox contextual actions use matching 40px controls.
- Navigation glyphs occupy 24px boxes; inline SVGs and status markers do not
  shrink beside longer labels. Overview icon links have centered hit areas.
- Corrected a pipeline text selector that also affected the icon container.
- Only directional arrows/rail controls mirror in RTL. Nondirectional product,
  phone, contact and status symbols retain their meaning.
- Browser geometry confirmed zero vertical center delta for inbox search,
  contact-context, actions and send icons; desktop nav and health icons also
  centered. This is representative evidence, not exhaustive pixel certification.

## Safety and runtime evidence

The normal runner/messaging worker was confirmed stopped before rebuilding shared
dependencies. Verification uses `scripts/preview_ui.py` with its own fictional
PostgreSQL database/login, no real provider credentials, disabled provider flags
and no messaging or voice worker. One fictional simulator reply was queued in
that disposable database only. No external message/call was made.

The earlier stale CRM `dist` blocker is resolved: the existing dependency build
rebuilt CRM and other web dependencies, then the overview rendered actual
fictional PostgreSQL metrics. The first preview was stopped and its owned
database/login removed before the final production build/preview.

## Verification

| Check | Result |
| --- | --- |
| Web Vitest | PASS — 121 tests in the final combined Phase 7 gate |
| Shared UI Vitest | PASS — 11 tests, including dark/light semantic contrast |
| Python | PASS — 677 passed, 66 correctly separated live/provider-dependent skips |
| Live PostgreSQL | PASS — 65 tests against PostgreSQL 18.6 |
| Scoped ESLint | PASS — web and shared UI, zero warnings |
| Prettier | PASS — web and shared UI |
| Strict TypeScript | PASS — web route types/typecheck and shared UI |
| Next production build | PASS — Next.js 16.3.3 compilation, TypeScript and all routes |
| Repository and secret guards | PASS — PostgreSQL-only, Alembic-only, sibling-independent; no tracked secrets found |
| Documentation guard | PASS after consolidation |
| Browser | PASS — English LTR and Hebrew RTL premium shell and retained application routes inspected at desktop and compact widths without page-level horizontal overflow; representative evidence, not certification |

The installed package CLIs were invoked through Node when the pnpm launcher
stalled: `node node_modules/vitest/vitest.mjs run` from each package,
`node node_modules/eslint/bin/eslint.js apps/web packages/ts/ui --max-warnings 0`
from root, and `node node_modules/next/dist/bin/next build` from `apps/web`.
No dependency version was changed in this application-only pass. Host Node
25.9.0 remains outside the repository's documented Node 24 range.

Final production review confirmed `/en` guest entry reaches the new login,
fictional sign-in reaches the actual-metric overview, the inbox retains disabled
real delivery, and the campaign empty state opens/focuses the existing draft
form. The final empty-state border/padding correction was rebuilt and inspected.
Observed compact English and Hebrew contact pages had 375px content width and
375px document scroll width, with no horizontal overflow. Representative desktop
operations likewise matched the viewport width. Layout review used the
computer-use skill; no browser action contacted a real provider.

All three upstreams were rechecked clean at their locked commits. `git diff
--check` passed. The target remains intentionally dirty with prior and current
uncommitted work; HEAD remains `7afa8534fc89259cd679da7ff58ec7546bd01b14`.

The final owned production preview used fictional data and no workers. Its helper
owned the temporary database/login and removed them on shutdown; no continuing
preview availability is claimed. The pnpm launcher briefly delayed server
startup, then the HTTP server and browser login were verified. No normal
development runner was started.

## Limits and handoff

Phase 7 implementation and its combined verification gate are complete in the
current uncommitted working tree. This is not a deployment, production-readiness
claim, accessibility certification, or measured performance improvement. The
web-only preview deliberately had no control/voice worker; unavailable services
remained visibly unavailable. Previously accepted Phase 6 simulator rehearsals
were not repeated against repopulated demo data, and broader cross-browser,
assistive-technology, and performance certification remain separate concerns.

Pre-existing uncommitted work is preserved. No commit, push, normal `.env` change,
provider operation or upstream modification is part of this pass.

## Follow-on platform management and connected flows — 9 September 2026

Status: implemented and verified in the dirty Phase 7 working tree; the coherent
checkpoint commits remain to be created. This follow-on expands the application-only presentation checkpoint
with the minimum persistence and authorization needed for PostgreSQL-backed
account/workspace management. It does not supersede the provider, deployment,
accessibility, or performance limits above.

- Settings now provides PostgreSQL-backed profile, current-password-protected
  email changes, password rotation, tenant naming, member role/removal controls,
  and hashed seven-day invitation links. The unauthenticated `/invite` entry
  handles new and existing accounts. Invitation links are copied manually; there
  is no email delivery implementation, trusted mailbox verification, resend
  workflow, or delivery claim.
- Canonical sessions expose display name and platform-administrator state. The
  shell distinguishes that state and permits switching among authorized active
  tenants; database functions preserve role checks, owner-management limits,
  last-owner protection, transaction-local tenant context, and audit records.
- `c567208f57bc` introduces the management functions. Successor
  `5725968b8ae1` fixes the non-superuser session resolver's ambiguous `role`
  reference; `e139bf3fde7e` then hardens invitation and tenant-administration
  access. The schema manifest names `e139bf3fde7e` as the sole expected head, and
  the owned local development database was migrated to that head. No remote or
  deployed database was changed.
- Inbox contact context now opens in the shared centered modal dialog instead of
  consuming a permanent third column. It links to the canonical contact and
  presents only already-loaded assignment, consent, channel, and service-window
  facts.
- Agents & Flows now separates library, canvas, run/activity, and handoff views.
  Persisted canonical node/edge definitions render in a deterministic, connected
  read-only canvas with pan/zoom controls and a screen-reader list. New drafts
  save an explicit six-node cross-channel graph; this is not a full visual editor
  parity claim.
- The development seed is identity-only. A separate cleanup utility defaults to
  a read-only inventory, accepts only loopback `or_on_platform_dev`, targets exact
  retired fixture identities, checks foreign-key dependents, and requires
  `--apply` for deletion. Its dry-run command is
  `uv run --no-sync python scripts/clean_development_demo_data.py`. The guarded
  apply was run only after review, and its immediate follow-up dry-run reported
  zero rows in every cleanup category. Voice flow resolution likewise requires a
  tenant-owned published flow instead of silently running a packaged fictional
  fallback.
- Shared UI patterns, restrained motion, shell/account/tenant controls,
  sign-in/invitation/start/error/loading states, operational layouts, and the
  system-health console received the current premium presentation pass. The
  health console validates its payload and scopes its claim to observed
  control-API/PostgreSQL state; it does not certify providers or workers.

Final combined evidence: 121 web tests passed; 680 Python tests passed with 66
correctly separated live/provider-dependent skips; all 65 live PostgreSQL tests
passed. Package/service TypeScript tests, strict typing, lint, format, builds,
contracts, migrations, guards, and dependency checks also passed. English LTR and
Hebrew RTL desktop/compact browser inspection covered the premium shell and
retained application routes. Host Node 25.9.0 still emits the expected warning
because the supported repository baseline is Node 24 LTS.

The remaining task is the uncommitted checkpoint review. No final commit,
invitation email or email verification, provider action, deployment,
accessibility certification, or production-readiness claim belongs to this
record.
