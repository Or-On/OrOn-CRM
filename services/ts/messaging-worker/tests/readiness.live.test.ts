import { execFileSync } from "node:child_process";
import { env as processEnvironment } from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ingestWhatsAppInbound,
  queueWhatsAppOutbound,
  createAgentProfileDraft,
  publishAgentProfile,
  setConversationOwnership,
} from "@or-on/crm";
import { createMessagingStore } from "../src/database.js";
import {
  SimulatorWhatsAppProvider,
  WhatsAppProviderError,
} from "../src/providers.js";

const source = process.env.READINESS_POSTGRES_URL;
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tenant = "10000000-0000-4000-8000-000000000001";
const actor = "20000000-0000-4000-8000-000000000001";
const sender = "19999999999999";
const channelConfig = {
  phoneNumberId: sender,
  graphApiVersion: "v26.0",
  wabaId: "18888888888888",
};

describe.skipIf(source === undefined)(
  "isolated readiness worker safety",
  () => {
    const name = `oron_readiness_worker_${randomUUID().replaceAll("-", "")}`;
    let maintenance: postgres.Sql;
    let admin: postgres.Sql;
    let web: postgres.Sql;
    let worker: postgres.Sql;
    let workerUrl: string;
    const cleanup: (() => Promise<void>)[] = [];

    beforeAll(async () => {
      if (source === undefined)
        throw new Error("explicit readiness PostgreSQL URL is required");
      const url = new URL(source);
      if (
        url.hostname !== "127.0.0.1" ||
        url.port !== "55439" ||
        url.pathname !== "/oron_readiness"
      )
        throw new Error(
          "readiness tests require the dedicated isolated PostgreSQL project",
        );
      url.pathname = "/postgres";
      maintenance = postgres(url.toString(), { max: 1 });
      cleanup.push(() => maintenance.end());
      await maintenance.unsafe(`CREATE DATABASE "${name}"`);
      cleanup.push(async () => {
        await maintenance.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      });
      url.pathname = `/${name}`;
      const env = {
        ...processEnvironment,
        DATABASE_URL: url.toString(),
        ENABLE_REAL_WHATSAPP: "false",
        ENABLE_REAL_TELEPHONY: "false",
        ENABLE_REAL_VOICE_PROVIDERS: "false",
        ENABLE_WHATSAPP_AI: "false",
        ENABLE_WHATSAPP_AUTO_CALLS: "false",
        WHATSAPP_ACCESS_TOKEN: "",
        WHATSAPP_APP_SECRET: "",
        LLM_API_KEY: "",
        DEV_AUTH_EMAIL: "fixture@example.invalid",
        DEV_AUTH_PASSWORD_HASH: "$argon2id$fixture-not-a-login-hash",
      };
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
        { cwd: root, env, stdio: "pipe" },
      );
      execFileSync(
        "uv",
        ["run", "--no-sync", "python", "db/seeds/seed_development.py"],
        { cwd: root, env, stdio: "pipe" },
      );
      admin = postgres(url.toString(), { max: 1 });
      cleanup.push(() => admin.end());
      url.searchParams.set("options", "-c role=platform_web");
      web = postgres(url.toString(), { max: 1 });
      cleanup.push(() => web.end());
      url.searchParams.set("options", "-c role=platform_messaging");
      workerUrl = url.toString();
      worker = postgres(workerUrl, { max: 1 });
      cleanup.push(() => worker.end());
    }, 120_000);

    afterAll(async () => {
      for (const close of cleanup.reverse()) await close();
    });

    async function scope(sql: postgres.TransactionSql) {
      await sql`SELECT set_config('app.current_tenant', ${tenant}, true), set_config('app.current_user', ${actor}, true), set_config('app.current_role', 'owner', true)`;
    }

    async function fixture(senderType: "user" | "agent" = "user") {
      const key = `readiness-${randomUUID()}`;
      return web.begin(async (sql) => {
        await scope(sql);
        const [contact] = await sql<
          { id: string }[]
        >`INSERT INTO crm.contacts(tenant_id,name,whatsapp_consent) VALUES (${tenant}::uuid,'Fictional safety fixture','granted') RETURNING id`;
        const phone = `+1202${String(BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 9)) % 10000000n).padStart(7, "0")}`;
        await sql`INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,validation_status,is_primary)
        VALUES (${tenant}::uuid,${contact?.id ?? null}::uuid,'whatsapp',${phone},'valid',true)`;
        const [channel] = await sql<
          { id: string }[]
        >`INSERT INTO messaging.channels(tenant_id,kind,provider,provider_account_id,status,configuration)
        VALUES (${tenant}::uuid,'whatsapp','meta',${sender},'active',${sql.json(channelConfig)})
        ON CONFLICT (provider,provider_account_id) WHERE provider_account_id IS NOT NULL DO UPDATE SET status='active' RETURNING id`;
        const [conversation] = await sql<
          { id: string }[]
        >`INSERT INTO messaging.conversations(tenant_id,channel_id,contact_id,customer_service_window_expires_at)
        VALUES (${tenant}::uuid,${channel?.id ?? null}::uuid,${contact?.id ?? null}::uuid,CURRENT_TIMESTAMP+INTERVAL '1 hour') RETURNING id`;
        if (
          conversation === undefined ||
          contact === undefined ||
          channel === undefined
        )
          throw new Error("fixture insert failed");
        if (senderType === "agent") {
          const profile = await createAgentProfileDraft(sql, actor, {
            name: "Safety fixture",
            systemPrompt: "Reply concisely.",
            channels: ["whatsapp"],
            locale: "en",
          });
          await publishAgentProfile(sql, actor, profile);
          const [version] = await sql<
            { id: string }[]
          >`SELECT id FROM agents.agent_profile_versions WHERE agent_profile_id=${profile}::uuid AND published_at IS NOT NULL`;
          if (version === undefined)
            throw new Error("fixture agent version missing");
          await setConversationOwnership(
            sql,
            conversation.id,
            actor,
            "ai",
            version.id,
          );
        }
        const input = {
          conversationId: conversation.id,
          explicitlyConfirmed: true,
          idempotencyKey: key,
          kind: "text" as const,
          provider: "meta" as const,
          realProviderEnabled: true,
          senderUserId: actor,
          senderType,
          text: "Fictional test reply",
        };
        const queued = await queueWhatsAppOutbound(sql, input, channelConfig);
        return {
          ...queued,
          input,
          contactId: contact.id,
          channelId: channel.id,
        };
      });
    }

    async function process(
      send = vi.fn(() =>
        Promise.resolve({
          messageId: `wamid.fixture-${randomUUID()}`,
        }),
      ),
    ) {
      const store = createMessagingStore(workerUrl, `safe-${randomUUID()}`, {
        simulator: new SimulatorWhatsAppProvider(),
        meta: { name: "meta", send },
      });
      try {
        await store.processAvailable();
      } finally {
        await store.close();
      }
      return send;
    }

    async function requestState(id: string) {
      const [row] = await admin<
        { status: string; last_error_code: string | null }[]
      >`SELECT status,last_error_code FROM messaging.outbound_requests WHERE id=${id}::uuid`;
      return row;
    }

    it("excludes LiveKit webhooks and other queues under the messaging role", async () => {
      await admin`INSERT INTO ops.inbound_events(provider,provider_account_id,provider_event_id,event_type,payload) VALUES ('livekit','fixture',${randomUUID()},'room_finished','{}')`;
      await admin`INSERT INTO ops.jobs(tenant_id,queue,job_type,payload) VALUES (${tenant}::uuid,'voice','fixture','{}')`;
      expect(
        await worker`SELECT id FROM ops.claim_inbound_events('isolated-reader',10,60)`,
      ).toHaveLength(0);
      expect(
        await worker`SELECT id FROM ops.claim_jobs_all_tenants('isolated-reader','voice',10,60)`,
      ).toHaveLength(0);
    });

    it("refuses prequeued simulation work without explicit development permission", async () => {
      const id = randomUUID();
      await admin`INSERT INTO ops.jobs(id,tenant_id,queue,job_type,payload)
        VALUES (${id}::uuid,${tenant}::uuid,'messaging','simulator.broadcast.recipient','{}')`;
      expect(await process()).not.toHaveBeenCalled();
      const [row] =
        await admin`SELECT status,last_error_safe FROM ops.jobs WHERE id=${id}::uuid`;
      expect(row).toMatchObject({
        status: "dead",
        last_error_safe: "simulation_disabled",
      });
    });

    it("claims just one pending effect, preserves scoped sender, and persists its receipt", async () => {
      const first = await fixture();
      const second = await fixture();
      const send = await process();
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]).toEqual([
        expect.objectContaining({ senderPhoneNumberId: sender }),
      ]);
      const states = await Promise.all([
        requestState(first.requestId),
        requestState(second.requestId),
      ]);
      expect(states.map((row) => row?.status).sort()).toEqual([
        "queued",
        "sent",
      ]);
      await process();
      expect((await requestState(second.requestId))?.status).toBe("sent");
    });

    it.each(["optout", "inactive_contact", "revoked_channel"])(
      "refuses %s changed after queue admission",
      async (restriction) => {
        const queued = await fixture();
        if (restriction === "optout")
          await admin`UPDATE crm.contacts SET whatsapp_opted_out_at=CURRENT_TIMESTAMP WHERE id=${queued.contactId}::uuid`;
        if (restriction === "inactive_contact")
          await admin`UPDATE crm.contacts SET lifecycle_status='archived' WHERE id=${queued.contactId}::uuid`;
        if (restriction === "revoked_channel")
          await admin`UPDATE messaging.channels SET status='revoked' WHERE id=${queued.channelId}::uuid`;
        expect(await process()).not.toHaveBeenCalled();
        expect(await requestState(queued.requestId)).toMatchObject({
          status: "failed",
          last_error_code: "outbound_eligibility_changed",
        });
      },
    );

    it("fences an already queued AI reply after human takeover", async () => {
      const queued = await fixture("agent");
      await web.begin(async (sql) => {
        await scope(sql);
        await setConversationOwnership(
          sql,
          queued.conversationId,
          actor,
          "human",
        );
      });
      expect(await process()).not.toHaveBeenCalled();
      expect((await requestState(queued.requestId))?.status).toBe("failed");
    });

    it("does not resend a reclaimed in-flight request with unknown outcome", async () => {
      const queued = await fixture();
      await admin`UPDATE messaging.outbound_requests SET status='sending' WHERE id=${queued.requestId}::uuid`;
      expect(await process()).not.toHaveBeenCalled();
      expect(await requestState(queued.requestId)).toMatchObject({
        status: "failed",
        last_error_code: "delivery_outcome_unknown",
      });
    });

    it("records ambiguous transport once without scheduling another send", async () => {
      const queued = await fixture();
      const send = vi.fn(() =>
        Promise.reject(
          new WhatsAppProviderError("delivery_outcome_unknown", false),
        ),
      );
      await process(send);
      await process(send);
      expect(send).toHaveBeenCalledOnce();
      expect(await requestState(queued.requestId)).toMatchObject({
        status: "failed",
        last_error_code: "delivery_outcome_unknown",
      });
    });

    it("rejects changed-payload key reuse while same-payload reuse remains idempotent", async () => {
      const queued = await fixture();
      await expect(
        web.begin(async (sql) => {
          await scope(sql);
          return queueWhatsAppOutbound(
            sql,
            { ...queued.input, text: "Different fictional reply" },
            channelConfig,
          );
        }),
      ).rejects.toThrow("different outbound request");
      const replay = await web.begin(async (sql) => {
        await scope(sql);
        return queueWhatsAppOutbound(sql, queued.input, channelConfig);
      });
      expect(replay.queued).toBe(false);
      expect(replay.requestId).toBe(queued.requestId);
      await process();
    });

    it("anchors service window to provider time rather than delayed processing or replay", async () => {
      const queued = await fixture();
      await process();
      const occurredAt = new Date(Date.now() - 26 * 3600_000).toISOString();
      const envelope = {
        providerAccountId: sender,
        providerEventId: `fixture-${randomUUID()}`,
        providerMessageId: `wamid.${randomUUID()}`,
        from: "+12025550199",
        profileName: "Fictional delayed message",
        text: "Fictional old message",
        occurredAt,
      };
      const result = await admin.begin(async (sql) => {
        await scope(sql);
        return ingestWhatsAppInbound(sql, envelope);
      });
      await admin.begin(async (sql) => {
        await scope(sql);
        return ingestWhatsAppInbound(sql, envelope);
      });
      const [row] = await admin<
        { expired: boolean }[]
      >`SELECT customer_service_window_expires_at<CURRENT_TIMESTAMP AS expired FROM messaging.conversations WHERE id=${result.conversationId}::uuid`;
      expect(row?.expired).toBe(true);
      expect((await requestState(queued.requestId))?.status).toBe("sent");
    });
  },
);
