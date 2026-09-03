import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  ingestSimulatedInbound,
  listMessagePage,
  queueWhatsAppOutbound,
} from "@or-on/crm";
import { createMessagingStore } from "../src/database.js";
import {
  MetaWhatsAppProvider,
  SimulatorWhatsAppProvider,
} from "../src/providers.js";

const adminUrl = process.env.MESSAGING_DIAGNOSTICS_TEST_DATABASE_URL;
const runtimeUrl = process.env.MESSAGING_DIAGNOSTICS_RUNTIME_DATABASE_URL;
const tenant = "10000000-0000-4000-8000-000000000001";
const otherTenant = "10000000-0000-4000-8000-000000000002";
const user = "20000000-0000-4000-8000-000000000001";

function connections() {
  if (!adminUrl || !runtimeUrl)
    throw new Error("Use the isolated --check-messaging runner");
  for (const value of [adminUrl, runtimeUrl]) {
    const url = new URL(value);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !/^\/oron_ui_preview_[a-f0-9]{32}$/u.test(url.pathname)
    )
      throw new Error("Only an owned fictional database is permitted");
  }
  if (new URL(adminUrl).pathname !== new URL(runtimeUrl).pathname)
    throw new Error("Test and runtime databases must match");
  return postgres(adminUrl, { max: 1, prepare: false });
}

async function fixture(admin: postgres.Sql) {
  return admin.begin(async (sql) => {
    await sql`SELECT set_config('app.current_tenant', ${tenant}, true),
      set_config('app.current_user', ${user}, true), set_config('app.current_role', 'owner', true)`;
    const inbound = await ingestSimulatedInbound(sql, user, {
      from: "+972509999988",
      profileName: "Fictional diagnostics contact",
      text: "Fictional inbound",
      providerEventId: randomUUID(),
      providerMessageId: randomUUID(),
    });
    await sql`UPDATE crm.contacts SET whatsapp_consent='granted'
      WHERE id=(SELECT contact_id FROM messaging.conversations WHERE id=${inbound.conversationId}::uuid)`;
    const queued = await queueWhatsAppOutbound(
      sql,
      {
        conversationId: inbound.conversationId,
        senderUserId: user,
        provider: "meta",
        realProviderEnabled: true,
        explicitlyConfirmed: true,
        idempotencyKey: randomUUID(),
        kind: "template",
        templateName: "fictional_approved",
        language: "en_US",
        parameters: [],
      },
      {
        phoneNumberId: "999999999",
        wabaId: "888888888",
        graphApiVersion: "v26.0",
      },
    );
    await sql`UPDATE messaging.messages SET provider_payload='{"existing":"preserved"}'::jsonb
      WHERE id=${queued.messageId}::uuid`;
    await sql`UPDATE ops.jobs SET max_attempts=2 WHERE reference_id=${queued.requestId}::uuid`;
    return queued;
  });
}
function store(fetcher: typeof fetch, report = vi.fn(), enabled = true) {
  if (!runtimeUrl) throw new Error("Isolated runtime URL required");
  return createMessagingStore(
    runtimeUrl,
    `diagnostics-${randomUUID()}`,
    {
      simulator: new SimulatorWhatsAppProvider(),
      meta: new MetaWhatsAppProvider({
        enabled,
        accessToken: "fictional-never-log-token",
        graphApiVersion: "v26.0",
        phoneNumberId: "999999999",
        fetch: fetcher,
        maxAttempts: 1,
      }),
    },
    report,
  );
}

describe.skipIf(!adminUrl || !runtimeUrl)(
  "isolated PostgreSQL send diagnostics (mocked HTTP only)",
  () => {
    it("persists safe details, reports once, and exposes only tenant-scoped projections", async () => {
      const admin = connections();
      const report = vi.fn();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        const open = await admin<
          { count: number }[]
        >`SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE datname=current_database() AND state='idle in transaction'`;
        expect(open[0]?.count).toBe(0);
        return new Response(
          JSON.stringify({
            error: {
              code: 100,
              error_subcode: 33,
              message:
                "Unsupported post request: fictional-never-log-token +972509999988",
              error_data: { details: "private body private@example.invalid" },
              fbtrace_id: "private-trace-must-not-leak",
            },
          }),
          { status: 400 },
        );
      });
      const worker = store(fetcher, report);
      try {
        const queued = await fixture(admin);
        expect(await worker.processAvailable()).toBe(1);
        expect(await worker.processAvailable()).toBe(0);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(report).toHaveBeenCalledOnce();
        expect(report.mock.calls[0]?.[0]).toMatchObject({
          code: "meta_100",
          diagnostic: {
            metaCode: 100,
            metaSubcode: 33,
            httpStatus: 400,
            reason: "resource_access",
            retryable: false,
          },
        });
        const rows = await admin<
          { status: string; provider_payload: unknown }[]
        >`
        SELECT status,provider_payload FROM messaging.messages WHERE id=${queued.messageId}::uuid`;
        expect(rows[0]).toMatchObject({
          status: "failed",
          provider_payload: {
            existing: "preserved",
            whatsappSendDiagnostic: { metaCode: 100, metaSubcode: 33 },
          },
        });
        const output = JSON.stringify(rows) + JSON.stringify(report.mock.calls);
        for (const forbidden of [
          "fictional-never-log-token",
          "+972509999988",
          "private body",
          "private@example.invalid",
          "private-trace-must-not-leak",
        ])
          expect(output).not.toContain(forbidden);
        await admin.begin(async (sql) => {
          await sql`SET LOCAL ROLE platform_web`;
          await sql`SELECT set_config('app.current_tenant', ${tenant}, true)`;
          const page = await listMessagePage(sql, queued.conversationId);
          expect(
            page.messages.find((message) => message.id === queued.messageId)
              ?.deliveryFailure,
          ).toMatchObject({
            code: "meta_100",
            diagnostic: { reason: "resource_access", metaSubcode: 33 },
          });
          expect(JSON.stringify(page)).not.toContain("whatsappSendDiagnostic");
          await sql`SELECT set_config('app.current_tenant', ${otherTenant}, true)`;
          expect(
            (await listMessagePage(sql, queued.conversationId)).messages,
          ).toEqual([]);
          await sql`SELECT set_config('app.current_tenant', '', true)`;
          expect(
            (await listMessagePage(sql, queued.conversationId)).messages,
          ).toEqual([]);
        });
      } finally {
        await worker.close();
        await admin.end();
      }
    });

    it.each([true, false])(
      "preserves bounded retry behavior and clears diagnostics only on success=%s",
      async (success) => {
        const admin = connections();
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ error: { code: 130429 } }), {
              status: 429,
            }),
          )
          .mockImplementation(() =>
            Promise.resolve(
              success
                ? new Response(
                    JSON.stringify({
                      messages: [{ id: `wamid.fixture-${randomUUID()}` }],
                    }),
                    { status: 200 },
                  )
                : new Response(JSON.stringify({ error: { code: 130429 } }), {
                    status: 429,
                  }),
            ),
          );
        const worker = store(fetcher);
        try {
          const queued = await fixture(admin);
          expect(await worker.processAvailable()).toBe(1);
          const retry = await admin<
            { status: string; last_error_code: string }[]
          >`
        SELECT status,last_error_code FROM messaging.outbound_requests WHERE id=${queued.requestId}::uuid`;
          expect(retry[0]).toMatchObject({
            status: "queued",
            last_error_code: "meta_130429",
          });
          // Advance only this fictional fixture's existing durable retry schedule.
          await admin`UPDATE ops.jobs SET available_at=CURRENT_TIMESTAMP WHERE reference_id=${queued.requestId}::uuid`;
          expect(await worker.processAvailable()).toBe(1);
          expect(await worker.processAvailable()).toBe(0);
          expect(fetcher).toHaveBeenCalledTimes(2);
          const result = await admin<
            { status: string; provider_payload: unknown }[]
          >`
        SELECT status,provider_payload FROM messaging.messages WHERE id=${queued.messageId}::uuid`;
          expect(result[0]?.status).toBe(success ? "sent" : "failed");
          if (success)
            expect(result[0]?.provider_payload).toEqual({
              existing: "preserved",
            });
          else
            expect(result[0]?.provider_payload).toMatchObject({
              whatsappSendDiagnostic: { retryable: true, reason: "rate_limit" },
            });
          await admin.begin(async (sql) => {
            await sql`SET LOCAL ROLE platform_web`;
            await sql`SELECT set_config('app.current_tenant', ${tenant}, true)`;
            const failure = (
              await listMessagePage(sql, queued.conversationId)
            ).messages.find((m) => m.id === queued.messageId)?.deliveryFailure;
            if (success) expect(failure).toBeNull();
            else expect(failure).toMatchObject({ code: "meta_130429" });
          });
        } finally {
          await worker.close();
          await admin.end();
        }
      },
    );

    it("records disabled refusal without HTTP or fabricated provider details", async () => {
      const admin = connections();
      const fetcher = vi.fn<typeof fetch>();
      const worker = store(fetcher, vi.fn(), false);
      try {
        const queued = await fixture(admin);
        expect(await worker.processAvailable()).toBe(1);
        expect(fetcher).not.toHaveBeenCalled();
        const rows = await admin<
          { provider_payload: unknown }[]
        >`SELECT provider_payload FROM messaging.messages WHERE id=${queued.messageId}::uuid`;
        expect(rows[0]?.provider_payload).toEqual({
          existing: "preserved",
          whatsappSendDiagnostic: null,
        });
      } finally {
        await worker.close();
        await admin.end();
      }
    });
  },
);
