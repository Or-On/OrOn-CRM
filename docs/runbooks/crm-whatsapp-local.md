# CRM and WhatsApp local runbook

1. Keep `ENABLE_REAL_WHATSAPP=false` and `ENABLE_REAL_TELEPHONY=false`.
2. Run `uv run python scripts/dev.py bootstrap` after dependency or migration
   changes.
3. Run `uv run python scripts/dev.py dev` for host development. This starts the
   web application, control API, live-agent foundation, and messaging worker;
   PostgreSQL remains in Compose.
4. Open `http://127.0.0.1:3000`, sign in with the ignored fictional development
   identity, and use **Inbox** to inject messages through the simulator.
5. Create a simulator campaign under **Campaigns**, start it, and keep the host
   messaging worker running until the durable recipient jobs are complete.

The Meta webhook route is intentionally unreachable while the provider flag is
false. Do not add a real app secret, access token, webhook registration, or public
tunnel during ordinary development. Enabling a provider later requires explicit
user approval in addition to configuration.

Useful verification commands:

```text
uv run python scripts/dev.py migration-check
uv run python scripts/dev.py db-verify-live
uv run python scripts/dev.py verify
```

API keys are issued from **Settings** and displayed once. Store a development key
outside source control. Call `GET /api/v1/contacts` with `Authorization: Bearer
<key>`. Revoke unused keys; never paste them into logs or fixtures.
