import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { queueCallOutcomeWhatsAppFollowup } from "@or-on/crm";
import { createMessagingStore } from "../src/database.js";

// Explicit opt-in. Creates/drops only its own UUID-named database; no .env reads.
const sourceUrl = process.env.CROSS_CHANNEL_TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tenantId = "10000000-0000-4000-8000-000000000001";
const otherTenantId = "10000000-0000-4000-8000-000000000002";
const userId = "20000000-0000-4000-8000-000000000001";

describe.skipIf(sourceUrl === undefined)("isolated call-outcome worker", () => {
  const databaseName = `oron_followup_test_${randomUUID().replaceAll("-", "")}`;
  let maintenance: postgres.Sql;
  let admin: postgres.Sql;
  let web: postgres.Sql;
  let workerUrl: string;
  const cleanup: (() => Promise<void>)[] = [];
  const send = vi.fn(() =>
    Promise.reject(new Error("provider must not be invoked")),
  );

  beforeAll(async () => {
    if (sourceUrl === undefined)
      throw new Error("explicit PostgreSQL test URL required");
    const url = new URL(sourceUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("isolated worker tests require localhost PostgreSQL");
    url.pathname = "/postgres";
    maintenance = postgres(url.toString(), { max: 1 });
    cleanup.push(() => maintenance.end());
    await maintenance.unsafe(`CREATE DATABASE "${databaseName}"`);
    cleanup.push(async () => {
      await maintenance.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    });
    url.pathname = `/${databaseName}`;
    const environment = {
      ...process.env,
      DATABASE_URL: url.toString(),
      ENABLE_REAL_WHATSAPP: "false",
      ENABLE_REAL_TELEPHONY: "false",
      WHATSAPP_ACCESS_TOKEN: "",
      WHATSAPP_APP_SECRET: "",
      DEV_AUTH_EMAIL: "operator@or-on.local",
      DEV_AUTH_PASSWORD_HASH: "$argon2id$isolated-test-not-a-login-hash",
    };
    execFileSync(
      "uv",
      ["run", "alembic", "-c", "db/alembic/alembic.ini", "upgrade", "head"],
      { cwd: root, env: environment, stdio: "pipe" },
    );
    execFileSync("uv", ["run", "python", "db/seeds/seed_development.py"], {
      cwd: root,
      env: environment,
      stdio: "pipe",
    });
    admin = postgres(url.toString(), { max: 1 });
    cleanup.push(() => admin.end());
    url.searchParams.set("options", "-c role=platform_web");
    web = postgres(url.toString(), { max: 2 });
    cleanup.push(() => web.end());
    url.searchParams.set("options", "-c role=platform_messaging");
    workerUrl = url.toString();
  }, 120_000);

  afterAll(async () => {
    for (const close of cleanup.reverse()) await close();
  });

  async function fixture(consent = "granted") {
    const contactId = randomUUID();
    const sessionId = randomUUID();
    await admin`
      INSERT INTO crm.contacts (id, tenant_id, name, whatsapp_consent)
      VALUES (${contactId}::uuid, ${tenantId}::uuid, 'Fictional follow-up contact', ${consent})
    `;
    await admin`
      INSERT INTO public.sessions
        (session_id, tenant_id, contact_id, provider, direction, room, status, outcome, flow_id)
      VALUES (${sessionId}::uuid, ${tenantId}::uuid, ${contactId}::uuid,
              'simulator', 'outbound', ${`fixture-${sessionId}`}, 'ended', 'completed', ${randomUUID()}::uuid)
    `;
    return { contactId, sessionId };
  }

  async function enqueue(sessionId: string, key = randomUUID()) {
    return web.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant', ${tenantId}, true),
                      set_config('app.current_user', ${userId}, true),
                      set_config('app.current_role', 'owner', true)`;
      return queueCallOutcomeWhatsAppFollowup(tx, userId, sessionId, key);
    });
  }

  async function runWorker(workerId: string) {
    const store = createMessagingStore(workerUrl, workerId, {
      simulator: { name: "simulator", send },
      meta: { name: "meta", send },
    });
    try {
      return await store.processAvailable();
    } finally {
      await store.close();
    }
  }

  it("runs with messaging privileges, fails closed without a tenant, and delivers once under concurrency/replay", async () => {
    const runtime = postgres(workerUrl, { max: 1 });
    try {
      const roles =
        await runtime`SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(roles[0]).toMatchObject({
        current_user: "platform_messaging",
        rolsuper: false,
        rolbypassrls: false,
      });
      expect(await runtime`SELECT id FROM crm.contacts`).toHaveLength(0);
    } finally {
      await runtime.end();
    }
    const { sessionId } = await fixture();
    const key = randomUUID();
    const job = await enqueue(sessionId, key);
    expect(await enqueue(sessionId, key)).toMatchObject({
      jobId: job.jobId,
      queued: false,
    });
    const different = await fixture();
    await expect(enqueue(different.sessionId, key)).rejects.toThrow(
      "different simulation work",
    );
    expect(
      await admin`SELECT id FROM audit.records WHERE target_id = ${job.jobId}::uuid AND action = 'simulation.queued'`,
    ).toHaveLength(1);
    await Promise.all([runWorker("followup-a"), runWorker("followup-b")]);
    expect(
      (
        await admin`SELECT status FROM ops.jobs WHERE id = ${job.jobId}::uuid`
      )[0]?.status,
    ).toBe("succeeded");
    // Simulate replay after a lost acknowledgement. The database effect is idempotent.
    await admin`UPDATE ops.jobs SET status = 'queued', completed_at = NULL WHERE id = ${job.jobId}::uuid`;
    await runWorker("followup-replay");
    const messages = await admin<
      {
        id: string;
        provider: string;
        status: string;
        channel_provider: string;
      }[]
    >`
      SELECT m.id, m.provider, m.status, c.provider AS channel_provider
      FROM messaging.messages m JOIN messaging.conversations v ON v.id = m.conversation_id
      JOIN messaging.channels c ON c.id = v.channel_id
      WHERE m.provider_message_id = ${`sim_call_followup_${job.jobId}`}
    `;
    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (message === undefined)
      throw new Error("simulated follow-up was not persisted");
    expect(messages[0]).toMatchObject({
      provider: "simulator",
      channel_provider: "simulator",
      status: "delivered",
    });
    expect(
      await admin`SELECT id FROM messaging.message_delivery_events WHERE message_id = ${message.id}::uuid`,
    ).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses admission without consent and rechecks opt-out after admission", async () => {
    const { sessionId, contactId } = await fixture("unknown");
    await expect(enqueue(sessionId)).rejects.toThrow("consent is required");
    await admin`UPDATE crm.contacts SET whatsapp_consent = 'granted' WHERE id = ${contactId}::uuid`;
    const job = await enqueue(sessionId);
    await admin`UPDATE crm.contacts SET whatsapp_opted_out_at = CURRENT_TIMESTAMP WHERE id = ${contactId}::uuid`;
    await runWorker("followup-revoked");
    expect(
      (
        await admin`SELECT status, last_error_safe FROM ops.jobs WHERE id = ${job.jobId}::uuid`
      )[0],
    ).toMatchObject({
      status: "dead",
      last_error_safe: "WhatsApp follow-up consent is required",
    });
    expect(
      await admin`SELECT id FROM messaging.messages WHERE provider_message_id = ${`sim_call_followup_${job.jobId}`}`,
    ).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["real-mode", "cross-tenant"])(
    "rejects %s payloads without invoking any provider",
    async (scenario) => {
      const { sessionId, contactId } = await fixture();
      const job = await enqueue(sessionId);
      if (scenario === "real-mode") {
        await admin`UPDATE ops.jobs SET payload = jsonb_set(payload, '{mode}', '"meta"'::jsonb) WHERE id = ${job.jobId}::uuid`;
      } else {
        const foreignContactId = randomUUID();
        await admin`INSERT INTO crm.contacts (id, tenant_id, name, whatsapp_consent)
        VALUES (${foreignContactId}::uuid, ${otherTenantId}::uuid, 'Other fictional tenant', 'granted')`;
        await admin`UPDATE ops.jobs SET reference_id = ${foreignContactId}::uuid,
        payload = jsonb_set(payload, '{contactId}', to_jsonb(${foreignContactId}::text)) WHERE id = ${job.jobId}::uuid`;
      }
      await runWorker(`followup-${scenario}`);
      expect(
        (
          await admin`SELECT status FROM ops.jobs WHERE id = ${job.jobId}::uuid`
        )[0]?.status,
      ).toBe("dead");
      expect(
        await admin`SELECT id FROM messaging.conversations WHERE contact_id = ${contactId}::uuid`,
      ).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();
    },
  );
});
