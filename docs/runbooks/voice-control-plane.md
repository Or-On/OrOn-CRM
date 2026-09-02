# Local voice control-plane runbook

This runbook starts only the opt-in Redis-backed LiveKit and LiveKit SIP control
plane. It does not start the provider-enabled voice agent, publish SIP/RTP ports,
create trunks or dispatch rules, provision a DID, or place a telephone call.

## One-time local configuration

Run the normal bootstrap first so the ignored `.env` exists. Set a local-only
LiveKit API key and a random API secret of at least 32 characters:

```dotenv
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_PORT=7880
LIVEKIT_API_KEY=<local key without whitespace or colon>
LIVEKIT_API_SECRET=<random local secret of at least 32 characters>
```

Do not reuse these values outside localhost and do not use the upstream
`devkey`/`secret` placeholder pair. All real-action flags must remain false.

## Start and verify

```bash
make voice-up
```

On Windows without GNU Make, use the exact cross-platform implementation:

```powershell
uv run python scripts/dev.py voice-up
```

The command installs the opt-in uv `voice` group, starts `redis`, `livekit`, and
`livekit-sip`, waits for their container health checks, and performs three
read-only API requests: list inbound trunks, list outbound trunks, and list
dispatch rules. It never calls a create, update, delete, dial, or transfer API.

Repeat the non-mutating check with:

```bash
make voice-check
```

Expected initial state is zero trunks and zero dispatch rules. A nonzero count is
reported but not modified; investigate it before continuing to DID work.

## Network and persistence boundaries

- LiveKit HTTP/WebSocket control traffic is published only on
  `127.0.0.1:${LIVEKIT_PORT:-7880}`.
- Redis is private to the Compose bridge and has no host port or persistent
  volume. It is disposable LiveKit/SIP coordination state, never authoritative
  platform persistence.
- SIP signaling `5060/udp`, SIP health `8080/tcp`, and RTP `10000-10100/udp`
  remain container-internal. This profile cannot receive a carrier call from the
  host/network and is not evidence of SIP media traversal on Docker Desktop.
- PostgreSQL remains the sole authoritative application database.

Inspect status/logs without exposing credentials:

```bash
docker compose --env-file .env -f infra/compose/compose.yaml --profile voice ps
docker compose --env-file .env -f infra/compose/compose.yaml --profile voice logs --tail 100 redis livekit livekit-sip
```

## Stop

```bash
make voice-down
```

This stops only the optional voice infrastructure. It does not remove the core
PostgreSQL volume or alter provider state.

## Unified operator workflow

With the core stack running, sign in using the fictional development account
and open `/flows`, `/voice`, and `/voice/campaigns`.

1. Publish a versioned voice flow from `/flows`.
2. Register a simulator DID with an explicit restricted documentation/test CIDR
   from `/voice`. This does not create a LiveKit or carrier resource.
3. Open a fictional contact, set voice consent to `granted`, and start a
   simulator call; replay uses the submitted idempotency key.
4. Inspect the call lifecycle, transcript event, outcome, artifact metadata,
   usage, and latency on `/voice/calls/[id]`.
5. Create and run a voice campaign. Only explicitly opted-in active contacts
   with usable E.164 identities are selected.

Use `make voice-check` (or `uv run python scripts/dev.py voice-check`) for the
optional local SIP control plane. It lists resources only. Do not treat an empty
provider inventory as drift repair authorization.

Real calls remain out of scope. Never set `ENABLE_REAL_TELEPHONY=true` without a
separate approved action and real-provider runbook.
