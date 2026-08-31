# Caddy boundary

Caddy is the future single public-origin edge for the one-VM development target.
It terminates TLS, applies baseline response headers, and reverse-proxies the
unified web application; Next.js then owns same-origin API routing. WebSocket and
provider-webhook paths remain disabled until their authenticated handlers exist.

`Caddyfile.example` is a reviewed direction, not an active Phase 1 deployment.
It is not included in the core Compose profile and requires an explicit
`PLATFORM_ORIGIN`. PostgreSQL and internal service ports are never proxied.
