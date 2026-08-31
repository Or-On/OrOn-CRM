# Unified web scope

- This is the future unified shell, not a wholesale WACRM, Or-on console, or
  OpenLive copy.
- Use feature-local public APIs; do not deep-import another feature's internals.
- Prefer server components; use client components only for real interactivity.
- Read bundled `node_modules/next/dist/docs/` before version-specific Next.js work.
- Meet the WCAG 2.2 AA direction: semantic HTML, labels, keyboard behavior,
  visible focus, reduced motion, sufficient contrast, and RTL-safe layout.
- Future sections must be labelled unavailable rather than faking completed data.
- Provider actions remain absent and default-off.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
