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
dark-first graphite/ink visual language with restrained luminous accents, strong
contrast, responsive layouts, RTL capability, and Hebrew-ready direction. Avoid
color-only status, excessive glass effects, and decorative motion. WCAG 2.2 AA is
the target, not a Phase 1 certification claim.

## Consequences

Shared primitives remain intentionally small. Source screens can later adapt
incrementally without wholesale UI rewrites or a global `components` dumping
ground.

## Verification

Component render and keyboard tests, token/theme build checks, visible-focus and
reduced-motion review, contrast checks, and RTL smoke tests.
