# Local WhatsApp webhook tunnel

This is an explicitly opt-in, temporary development edge for Meta callbacks,
not a public deployment of the product. No account/domain purchase is required.
Cloudflare terminates public HTTPS and carries the webhook traffic; use it only
for authorized development messages. Quick tunnels have no uptime SLA and change
hostname when recreated. Keep Docker, the tunnel, host web on port 3000 and the
messaging worker running while receiving callbacks. Do not expose PostgreSQL.

## Start, inspect and stop (PowerShell)

Run from the OrOn-Platform repository root, with the normal app already running:

```powershell
docker compose -f infra/compose/webhook-tunnel.yaml up -d
$tunnel = Invoke-RestMethod http://127.0.0.1:18788/quicktunnel
"https://$($tunnel.hostname)/api/webhooks/whatsapp"
```

The second command prints only the public callback URL, not credentials.
The metrics/control endpoint on 18788 and gateway diagnostics on 18787 are
loopback-only. The Caddy health listener on 8081 is container-only. Check:

```powershell
docker compose -f infra/compose/webhook-tunnel.yaml ps
(Invoke-WebRequest http://127.0.0.1:18788/ready).StatusCode
```

Expected tunnel readiness is 200. Caddy's healthcheck proves the gateway process
is alive, not that Next.js/PostgreSQL is ready. Meta's verification and a real
signed inbound event are separate checks. If the app is stopped, callbacks fail
with 502/503; they do not silently succeed. Review queued real work before
restarting the normal worker: it may process previously authorized sends.

Stop only this temporary edge (leaves the app and database untouched):

```powershell
docker compose -f infra/compose/webhook-tunnel.yaml down
```

This removes only the two stateless tunnel containers and their dedicated
network; no application volumes are attached. Containers intentionally do not
auto-start after Docker/host restart. Restart the tunnel explicitly and re-read
its URL; update Meta if it changed. A later stable domain or named tunnel
deployment requires its own explicit setup; do not rely on this URL permanently.

## Configure Meta manually

1. Select the correct app in Meta for Developers. Open its WhatsApp configuration
   or Webhooks section for the `whatsapp_business_account` object (dashboard
   labels may vary). Do not select a Facebook Page/Marketing webhook instead.
2. Enter the URL printed above as Callback URL, without a trailing slash.
3. Copy the existing `WHATSAPP_WEBHOOK_VERIFY_TOKEN` value from ignored `.env`
   into Verify token. This is **not** the access token or app secret. Do not paste
   it in chat, screenshots or shell commands. The web process must have loaded
   that same value and `ENABLE_REAL_WHATSAPP=true`.
4. Choose Verify and save, then subscribe the **messages** field. It carries both
   incoming messages and outgoing status updates.
5. Ensure this same app is subscribed to the business WABA, not just that the
   callback verification passed. If incoming delivery remains absent, inspect
   the app-to-WABA subscription separately. The documented management endpoint
   is `/{WABA-ID}/subscribed_apps`; modifying it requires explicit authorization
   and a suitably authorized management token. This tunnel does not invoke it.
6. Confirm the selected WABA and Phone Number ID match `.env` and that
   `WHATSAPP_APP_SECRET` belongs to this app. App ID, WABA ID and Phone Number ID
   are different identifiers.
7. Send a **new text message** from your personal WhatsApp to the configured
   business number. Wait for it to appear in OrOn's real Meta conversation. It
   must arrive as a signed webhook, not as a simulator injection. Then reply
   manually through REAL delivery with consent and the explicit send confirmation.

Do not assume messages sent before the subscription will be replayed. The Meta
dashboard's fabricated test event may not contain your real Phone Number ID and
therefore is not proof of canonical inbox ingestion.

## Approved templates

An approved template is a reusable message format reviewed by Meta and owned by
your WABA, with an exact name, language and parameter shape. Outside the
24-hour customer-service window, use an approved template. Inside that window,
free-form replies are permitted; the window follows the customer's latest
message, not your outbound template. Consent, opt-out and other policy controls
still apply. Approval is not unrestricted permission to contact anyone.

In WhatsApp Manager, select the correct WABA, open Message templates and create
one. Pick the category matching the actual content: utility for eligible
transaction/service updates, marketing for promotions/outreach, authentication
for OTP flows. Meta decides approval/category; do not disguise promotional text
as utility. Choose the intended language, provide text and fictional sample
values for any variables, submit and wait until approved/active. Delivery can
still fail for account, recipient, payment, quality or policy restrictions.

For the current OrOn composer, start with a **body-only text template**, with no
media header, dynamic buttons, authentication buttons or named variables. The
implemented UI/provider path accepts the exact template name/language and ordered
text body parameters separated by `|`; e.g. a body with `{{1}}` and `{{2}}` needs
two corresponding values. These are parameters, not replacement arbitrary text.
Hebrew language code is `he`; use the language actually approved in Meta, not a
guessed code. Approved means in Meta: typing an arbitrary name into OrOn does not
create or approve a template. Full template management/synchronization is deferred.

Do not use Meta's `hello_world` test-number template for the real business sender;
the observed production failure was code 131058. Create/use your own approved
template under the business WABA instead. Template charges can apply according
to Meta's current category/destination pricing; check WhatsApp Manager rather
than assuming a test send is free.

## Security and verification

- Dedicated network, pinned image digests, non-root/read-only containers, bounded
  resources, no provider `.env` or Docker socket mounts, no core service restarts.
- Caddy permits **only GET/POST `/api/webhooks/whatsapp`**, rejects other methods
  and paths, limits bodies to 1 MB and uses bounded upstream timeouts. It strips
  cookies/Authorization; the raw body and `X-Hub-Signature-256` remain unchanged.
- Next.js retains verify-token/signature checks, provider flag, durable ingestion
  and deduplication. Caddy does not manufacture successful webhook responses.
- No local gateway/tunnel request logs; Docker log drivers are disabled. Discover
  the hostname through the loopback `/quicktunnel` endpoint instead of logs.
- Next.js development incoming-request logging excludes webhook URLs, because
  GET verification carries the token in the query string. Do not enable verbose
  proxy capture or full URL logging for this route. Cloudflare remains an
  external traffic processor; this does not promise zero provider-side logging.
- Readiness and manual callback checks do not prove real Meta delivery. Configure
  Meta and verify a fresh personal inbound before declaring end-to-end success.

References: [Cloudflare quick tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/),
[Meta webhook subscriptions](https://www.postman.com/meta/whatsapp-business-platform/folder/ypn8q0n/webhook-subscriptions),
[Meta template examples](https://www.postman.com/meta/whatsapp-business-platform/folder/lczy75a/templates),
[WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/).
