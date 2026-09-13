# ADR 0015: Unified UI design system

- Status: Accepted
- Date: 2026-08-31
- Owners: Product engineering

## Context

The source products have useful UI behavior and libraries, but the unified product
needs consistent tokens, accessibility, theming, interaction feedback, and public
component APIs. Rebuilding every source primitive or forcing every feature onto a
single component library would both increase migration risk.

## Decision

Create `packages/ts/ui` as a small shared foundation for semantic color, dark and
light themes, typography, spacing, surfaces, elevation, radii, focus, and reduced
motion. Initial accessible primitives cover common controls and system states.
Features own domain-specific components behind intentional public APIs.

Preserve mature source-compatible UI libraries where useful. Establish a
brand-led light and dark visual language with a restrained blue interaction
signal, near-white light canvases, layered navy dark surfaces, strong contrast,
responsive layouts, RTL capability, and Hebrew-ready direction. Teal is reserved
for positive state rather than used as the primary action color. Avoid color-only
status, excessive glass effects, and decorative motion. WCAG 2.2 AA is the
target, not a certification claim.

The 10 September 2026 product-experience brief supersedes the earlier Studio Admin
pixel-clone direction. Or-On is now the primary brand authority. Keep the shared
semantic token and component APIs; recompose each route for its actual task and
data contract. The historical template is not the current visual specification.

The Phase 7 brand refinement uses an original code-native signal/core mark and a
conversation-path motif. The public [OrOn site](https://or-on.io/) is a visual
reference for verified royal/electric/sky colors, deep navy, Inter/Poppins/Heebo
typography and restrained technical motifs. Its logo,
illustrations, layout, copy, customer marks, performance figures and commercial
claims are not source assets and must not be copied into the platform.

Use shared SelectInput for native single selection with a customizable top-layer
picker where supported and an accessible native fallback elsewhere; use Combobox
for searchable contact sets. Popover, Dialog, ConfirmDialog and Tabs own keyboard,
focus, dismissal, collision, RTL and reduced-motion behavior. Form drafts stay
mounted across dismissal and tab changes. Confirmation UI never bypasses provider
flags, consent, explicit approvals or server authorization.

Historical charts require authoritative tenant-scoped reads and visible time/data
scope. Overview uses a 14-UTC-day message query with tenant-isolation tests. Voice
summaries explicitly describe the returned sample; current eligible campaign
audience is not a historic completion denominator. Do not invent deltas or trends.
Route inventory and evidence: `docs/plans/or-on-product-experience-2026-09-10.md`.

## Consequences

Shared primitives remain intentionally focused. Source screens can adapt
incrementally without wholesale UI rewrites or a global `components` dumping
ground. New shared primitives are added when at least one real workflow needs
their accessibility and interaction contract.

## Verification

Component render and keyboard tests, token/theme build checks, visible-focus and
reduced-motion review, contrast checks, and RTL smoke tests.
