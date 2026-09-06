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
dark-first navy/ink visual language with an electric-blue interaction signal,
ice-toned light surfaces, strong contrast, responsive layouts, RTL capability,
and Hebrew-ready direction. Teal is reserved for positive state rather than used
as the primary action color. Avoid color-only status, excessive glass effects,
and decorative motion. WCAG 2.2 AA is the target, not a certification claim.

The Phase 7 brand refinement uses an original code-native signal/core mark and a
conversation-path motif. The public [OrOn site](https://or-on.io/) is a visual
reference for technical confidence, deep navy and signal language only. Its logo,
illustrations, layout, copy, customer marks, performance figures and commercial
claims are not source assets and must not be copied into the platform.

## Consequences

Shared primitives remain intentionally focused. Source screens can adapt
incrementally without wholesale UI rewrites or a global `components` dumping
ground. New shared primitives are added when at least one real workflow needs
their accessibility and interaction contract.

## Verification

Component render and keyboard tests, token/theme build checks, visible-focus and
reduced-motion review, contrast checks, and RTL smoke tests.
