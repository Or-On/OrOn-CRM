# Caddy boundary

Caddy is the future single public-origin edge for the one-VM development target.
It terminates TLS, applies baseline response headers, and reverse-proxies the
unified web application; Next.js then owns same-origin API routing. WebSocket and
provider-webhook paths remain disabled until their authenticated handlers exist.

`Caddyfile.example` is a reviewed direction, not an active Phase 1 deployment.
It is not included in the core Compose profile and requires an explicit
`PLATFORM_ORIGIN`. PostgreSQL and internal service ports are never proxied.

`Caddyfile.webhook-local` is the separately opt-in development webhook gateway.
It permits only GET/POST on the exact WhatsApp callback route; all dashboard,
internal API and health paths are denied at the public listener. It is started
only by `infra/compose/webhook-tunnel.yaml`, never core bootstrap/dev.
See [local webhook setup](../../docs/runbooks/whatsapp-webhook-local.md).
