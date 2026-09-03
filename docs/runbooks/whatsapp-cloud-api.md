# Real WhatsApp development runbook

The safe default is the simulator. Complete these steps only for a development
Meta app/account you control. Never paste secrets into source, commands, chat,
screenshots, migrations, or logs.

## Meta Developer Dashboard

1. Open Meta for Developers, select app `1438019764708355`, and confirm the
   WhatsApp product is attached to Business Portfolio `1759453294641663`.
2. In WhatsApp API Setup, confirm WABA `1507601250680263`, Phone Number ID
   `1312069101984418`, and the displayed business number `+972-3-825-6893`.
3. Create/choose a development system user and issue a non-expired token with the
   minimum WhatsApp permissions needed by Meta, including
   `whatsapp_business_messaging`. Add management permission only if you later add
   template-management/synchronization; this implementation does not need it to
   send an already-approved template.
4. Add an HTTPS-reachable callback ending in `/api/webhooks/whatsapp`. Configure
   the same random verify token in Meta and local `.env`, then subscribe the WABA
   `messages` field. This repository does not perform subscription or other Meta
   resource mutation automatically.
5. For business-initiated/out-of-window tests, create and wait for an approved
   template in WhatsApp Manager. Record its exact lowercase name and language.
6. Ensure the destination is permitted by the app/account mode and that you have
   documented consent. Test numbers and production numbers follow Meta's own
   recipient and review rules.

## Ignored `.env`

Keep `ENABLE_REAL_WHATSAPP=false` through bootstrap and automated verification.
Populate only your ignored local `.env`:

```dotenv
WHATSAPP_ACCESS_TOKEN=<secret token>
WHATSAPP_APP_SECRET=<secret app secret>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<random secret verify token>
WHATSAPP_PHONE_NUMBER_ID=1312069101984418
WHATSAPP_WABA_ID=1507601250680263
WHATSAPP_GRAPH_API_VERSION=v26.0
ENABLE_REAL_WHATSAPP=true
```

Then run `make dev`. The host-mode web and messaging-worker receive the env;
production-shaped core Compose intentionally forces the real flag off.

In Contacts, set WhatsApp consent to **Granted** only with a valid basis. In the
Inbox select **REAL Meta WhatsApp delivery**, select text or template, check the
real-send acknowledgement, and accept the final browser confirmation. Text is
refused without a verified inbound message in the previous 24 hours. Use an
approved template outside that window.

## Protected single-recipient smoke command

This bypasses product persistence and exists only to isolate Meta connectivity.
It never runs in tests/CI and still checks the lowest-boundary kill switch.

```bash
pnpm --filter @or-on/messaging-worker smoke:whatsapp -- \
  --real --recipient +972501234567 --text "Explicit test message"
```

Or an approved template:

```bash
pnpm --filter @or-on/messaging-worker smoke:whatsapp -- \
  --real --recipient +972501234567 --template approved_name \
  --language he --parameters "first|second"
```

The command masks the recipient, does not print the body, and requires typing
`SEND_REAL_WHATSAPP` before the request. Prefer the durable UI/worker path for
normal testing.

## Troubleshooting and shutdown

### Send diagnostics in the Inbox

Failed messages (and queued retries with a recorded error) now show **Delivery
issue → Safe diagnostic details**, in English or Hebrew. This includes the
saved code, HTTP status, numeric Meta subcode when supplied, the existing
transient/permanent classification, and an allowlisted explanation derived from
recognized provider errors. The worker logs the same safe fields under
`whatsapp_outbound_failed`, with a job ID for correlation.

No raw Meta error text, provider trace strings, access tokens, recipient numbers,
message bodies, or template parameter values are included in these diagnostics.
Unknown wording is deliberately omitted instead of relying on a best-effort
secret regex. An unrecognized error remains explicitly unexplained. Code `100`
alone does not prove a template, credential, or permission problem.

Historical failures retain their saved code but cannot acquire details that were
never recorded. This change does not requeue them. After restarting your own
development runner, a future explicitly confirmed send will capture the new
diagnostic; the diagnostic panel itself has no send/retry action. Review any
existing queued real work before restarting, because the normal worker may
process it. Neither environment values nor provider permissions need to be
changed just to enable this local diagnostic feature. No migration is required.

Run isolated PostgreSQL diagnostics with **mocked provider HTTP only**:

```powershell
uv run --no-sync python scripts/preview_ui.py --check-messaging
```

Use the pinned Node/pnpm workspace toolchain and build `@or-on/crm` first if its
generated `dist` is stale. This runner creates/removes its own fictional database
and login role, inherits no provider credentials, and exercises the store as
`platform_messaging`. It does not start the real worker or consume developer jobs.
Default unit suites keep these database tests explicitly skipped until this
isolated test environment is supplied.

- `provider_disabled`: flag is not exactly `true` in the process environment.
- `provider_not_configured`: one of the six required WhatsApp env values is
  absent/invalid.
- 400: validate E.164, message/template shape, language, and Meta window/template
  rules.
- 401/403: inspect token expiry, app/WABA/phone ownership, and permissions in Meta;
  never paste the token into logs.
- 429/5xx/timeout: the adapter retries within a strict bound and the durable job
  then applies bounded PostgreSQL retry/dead-letter behavior.

To stop real admission immediately, set `ENABLE_REAL_WHATSAPP=false` and restart
web plus messaging-worker. Already queued real jobs will also be refused at the
provider boundary and become safely failed/dead according to the retry policy.
