import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createMessagingStore } from "./database.js";
import type { WhatsAppProvider } from "./providers.js";

const url = process.env.CRM_TEST_DATABASE_URL;
// This committed queue scenario must run in its dedicated fresh fixture; the
// normal parallel CRM fixture contains unrelated jobs and is never consumed.
const dedicatedFixture =
  url !== undefined && /^\/oron_crm_[a-f0-9]{32}$/u.test(new URL(url).pathname);
describe.skipIf(!dedicatedFixture)("expanded durable inbound claims", () => {
  it("claims new media/types, preserves exclusions, and stores reactions without model/tool jobs", async () => {
    const target = new URL(required(url));
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55480" ||
      !/^\/oron_crm_[a-f0-9]{32}$/u.test(target.pathname)
    )
      throw new Error("independent synthetic fixture required");
    // This worker claims across tenants. A tenant-only fixture in a shared DB
    // would consume unrelated cases' jobs even if assertions were filtered.
    const maintenanceUrl = new URL(target);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), { max: 1 });
    const databaseName = "oron_crm_" + randomUUID().replaceAll("-", "");
    await maintenance.unsafe(`CREATE DATABASE "${databaseName}"`);
    target.pathname = "/" + databaseName;
    const db = postgres(target.toString(), { max: 1, prepare: false });
    const tenant = randomUUID(),
      channel = randomUUID(),
      account = randomUUID();
    try {
      execFileSync(
        "uv",
        [
          "run",
          "--no-sync",
          "alembic",
          "-c",
          "db/alembic/alembic.ini",
          "upgrade",
          "head",
        ],
        {
          cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
          env: { ...process.env, DATABASE_URL: target.toString() },
          stdio: "pipe",
        },
      );
      await db`INSERT INTO public.tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional event claim',${tenant},'active')`;
      await db`INSERT INTO messaging.channels(id,tenant_id,kind,provider,display_address,provider_account_id,status)
        VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','meta','Fictional event claim',${account},'active')`;
      const ids: string[] = [];
      for (const type of ["audio", "video", "interactive", "event"]) {
        const id = randomUUID();
        const payload = {
          providerAccountId: account,
          providerEventId: id,
          providerMessageId: id,
          from: "+12025550123",
          profileName: "Fictional contact",
          contentType: type,
          text: "Fictional input",
          ...(type === "event"
            ? {
                providerMessageType: "reaction",
                reaction: { messageId: randomUUID(), emoji: "👍" },
              }
            : {}),
        };
        const rows = await db<
          { id: string }[]
        >`SELECT (ops.accept_whatsapp_inbound(${account},${id},
          ${`whatsapp.message.${type}`},${db.json(payload)})).id`;
        ids.push(required(rows[0]).id);
      }
      const excludedIds = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      await db`INSERT INTO ops.inbound_events(id,tenant_id,provider,provider_account_id,
        provider_event_id,event_type,payload,available_at,attempts,max_attempts)
        VALUES(${required(excludedIds[0])}::uuid,${tenant}::uuid,'livekit',${account},${randomUUID()},
          'whatsapp.message.audio','{}',clock_timestamp(),0,4),
        (${required(excludedIds[1])}::uuid,${tenant}::uuid,'meta',${account},${randomUUID()},
          'voice.quality.summary.v1','{}',clock_timestamp(),0,4),
        (${required(excludedIds[2])}::uuid,NULL,'meta',${account},${randomUUID()},
          'whatsapp.message.audio','{}',clock_timestamp(),0,4),
        (${required(excludedIds[3])}::uuid,${tenant}::uuid,'meta',${account},${randomUUID()},
          'whatsapp.message.video','{}',clock_timestamp()+interval '1 hour',0,4)`;
      await db.begin(async (sql) => {
        await sql`SET LOCAL ROLE platform_messaging`;
        const claimed = await sql<
          { id: string; event_type: string }[]
        >`SELECT id,event_type FROM ops.claim_inbound_events('fictional-claim-test',100,60)`;
        expect(claimed.map((row) => row.id).sort()).toEqual([...ids].sort());
        for (const item of claimed) {
          // Restore newly claimed jobs inside this fixture only so the real
          // worker path can consume them; no live/provider operation is used.
          if (item.event_type !== "whatsapp.message.event")
            await sql`SELECT ops.complete_inbound_event(${item.id}::uuid,'fictional-claim-test')`;
        }
      });
      await db`UPDATE ops.inbound_events SET status='received',locked_at=NULL,locked_by=NULL
        WHERE tenant_id=${tenant}::uuid AND event_type='whatsapp.message.event'`;
      let sends = 0,
        models = 0;
      const provider = (name: "meta" | "simulator"): WhatsAppProvider => ({
        name,
        send: () => {
          sends++;
          return Promise.reject(new Error("unexpected send"));
        },
      });
      const store = createMessagingStore(
        target.toString(),
        "fictional-event-worker",
        { meta: provider("meta"), simulator: provider("simulator") },
        undefined,
        {
          realWhatsAppEnabled: true,
          aiProvider: {
            decide: () => {
              models++;
              return Promise.reject(new Error("unexpected model"));
            },
          },
        },
      );
      try {
        expect(await store.processAvailable()).toBeGreaterThan(0);
      } finally {
        await store.close();
      }
      expect(models).toBe(0);
      expect(sends).toBe(0);
      const events = await db<
        { status: string }[]
      >`SELECT status FROM ops.inbound_events
        WHERE tenant_id=${tenant}::uuid AND event_type='whatsapp.message.event'`;
      expect(events[0]?.status).toBe("processed");
      expect(
        (
          await db<{ status: string }[]>`SELECT status FROM ops.inbound_events
        WHERE id=ANY(${excludedIds}::uuid[])`
        ).every((row) => row.status === "received"),
      ).toBe(true);
      expect(
        await db`SELECT id FROM ops.jobs WHERE tenant_id=${tenant}::uuid AND job_type='whatsapp.ai.reply'`,
      ).toHaveLength(0);
    } finally {
      await db.end();
      await maintenance.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    }
  }, 120000);
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected dedicated fixture value");
  return value;
}
