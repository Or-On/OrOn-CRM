# Verification ledger

All results below belong to this local session, not historical runs. Detailed sanitized test logs are in ignored `.artifacts/poc-rescue-local/`.

| Command / check | Result | Scope |
|---|---|---|
| `docker ps` | PostgreSQL 18.6 healthy, loopback 5433 | Existing local service |
| Read-only existing DB inventory | schema `6f8b0d3e5a29`; 2 tenants, no ProTouch | No mutation |
| `uv run --no-sync python .artifacts/poc_rescue_verify.py auth pnpm --filter @or-on/auth test` | 14 files, 66 passed, 0 skipped, exit 0 | Fresh migrated PostgreSQL; no real providers |
| LiveKit read-only provider inventory | 1 Or-On outbound trunk; 0 inbound trunks; 0 dispatch rules | Existing configured project only; not a call |
| GCP instance / WIF describe | instance e2-medium RUNNING; WIF checks old organization | Read-only API |
| GCP SSH through IAP | DENIED: external organization OS Login role absent | No runtime inventory or deployment |

No live message acceptance, received caller ID, device typing, 30-day SLI, 48-hour canary, Hebrew human evaluation, or off-host restore proof exists in this ledger yet.
