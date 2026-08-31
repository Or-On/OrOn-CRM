# TypeScript service scope

- `live-agent` is the later host for retained OpenLive Hono/WebSocket/ACP/provider
  architecture; `messaging-worker` is the later host for retained WACRM provider
  and durable-work behavior.
- Phase 1 entrypoints prove configuration, lifecycle, logging, and contracts only.
- Keep provider and persistence clients behind ports; no real provider traffic.
- Workers use an equivalent process health signal and graceful shutdown rather
  than adding HTTP solely for symmetry.
- Use package public exports and strict TypeScript; no sibling repository imports.
