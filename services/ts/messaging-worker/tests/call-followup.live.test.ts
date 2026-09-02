import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assignConversation,
  listConversations,
  listMessages,
  listQuickReplies,
  listTeamMembers,
  queueCallOutcomeWhatsAppFollowup,
  queueWhatsAppTriggeredCall,
  ingestSimulatedInbound,
  listContactActivity,
  createAgentProfileDraft,
  publishAgentProfile,
  createCanonicalFlowDraft,
  publishExecutableFlow,
  queueCanonicalSimulation,
} from "@or-on/crm";
import { createMessagingStore } from "../src/database.js";
import { SimulatorWhatsAppProvider } from "../src/providers.js";

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
  let testDatabaseUrl: string;
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
    testDatabaseUrl = url.toString();
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

  it("loads Inbox data and validates assignments using only platform_web privileges", async () => {
    await web.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant', ${tenantId}, true),
                      set_config('app.current_user', ${userId}, true)`;
      const members = await listTeamMembers(tx);
      expect(members.map((member) => member.userId)).toContain(userId);
      const conversations = await listConversations(tx);
      const conversation = conversations[0];
      if (conversation === undefined)
        throw new Error("seeded Inbox conversation required");
      expect(await listMessages(tx, conversation.id)).not.toHaveLength(0);
      expect(await listQuickReplies(tx)).not.toHaveLength(0);
      expect(await assignConversation(tx, conversation.id, userId)).toBe(true);
      await expect(
        assignConversation(tx, conversation.id, randomUUID()),
      ).rejects.toThrow("assignee must be a current tenant member");
      expect(await assignConversation(tx, conversation.id, null)).toBe(true);
    });
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

  it("executes the canonical voice path using a frozen retained flow and resumes into handoff", async () => {
    const key = randomUUID(),
      retainedId = randomUUID();
    await admin`INSERT INTO public.flows(flow_id,version,tenant_id,source,spec,components_version)
      VALUES(${retainedId}::uuid,1,${tenantId}::uuid,'{}',${admin.json({ id: retainedId, version: 1, entry: "done", language: "he", nodes: [{ name: "done", pre_actions: [{ type: "tts_say", text: "שלום" }], post_actions: [{ type: "end_conversation" }] }] })},'fixture')`;
    const result = await web.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.current_user',${userId},true)`;
      const inbound = await ingestSimulatedInbound(tx, userId, {
        providerEventId: key,
        providerMessageId: key,
        from: "+12025550187",
        profileName: "Fictional voice flow contact",
        text: "Simulator only",
      });
      const contact = (
        await tx`SELECT contact_id FROM messaging.conversations WHERE id=${inbound.conversationId}::uuid`
      )[0]?.contact_id as string;
      await tx`UPDATE crm.contacts SET voice_consent='granted' WHERE id=${contact}::uuid`;
      const agent = await createAgentProfileDraft(tx, userId, {
        name: `Voice ${key}`,
        systemPrompt: "Fictional",
        channels: ["voice"],
      });
      await publishAgentProfile(tx, userId, agent);
      const version = (
        await tx`SELECT id FROM agents.agent_profile_versions WHERE agent_profile_id=${agent}::uuid`
      )[0]?.id as string;
      const definition = await createCanonicalFlowDraft(
        tx,
        userId,
        `Voice ${key}`,
        version,
        {
          schemaVersion: "1.0",
          channels: ["voice"],
          nodes: [
            { id: "start", type: "start" },
            {
              id: "call",
              type: "voice.call",
              configuration: { flowId: retainedId, flowVersion: 1 },
            },
            {
              id: "handoff",
              type: "handoff",
              configuration: { reason: "Fictional voice completion" },
            },
            { id: "end", type: "end" },
          ],
          edges: [
            { id: "a", source: "start", target: "call" },
            { id: "b", source: "call", target: "handoff" },
            { id: "c", source: "handoff", target: "end" },
          ],
        },
      );
      expect(await publishExecutableFlow(tx, userId, definition)).toBe(true);
      return {
        contact,
        runId: await queueCanonicalSimulation(
          tx,
          userId,
          definition,
          inbound.conversationId,
          "voice",
          key,
        ),
      };
    });
    await runWorker("canonical-voice");
    expect(
      (
        await admin`SELECT status FROM automation.flow_runs WHERE id=${result.runId}::uuid`
      )[0]?.status,
    ).toBe("waiting");
    const script = `
import asyncio, os
from sqlalchemy.ext.asyncio import create_async_engine
from control_api.voice import PostgresVoiceRepository
from control_api.voice_jobs import consume_voice_simulation
async def main():
    url=os.environ['TEST_DATABASE_URL']
    engine=create_async_engine(url.replace('postgresql://','postgresql+asyncpg://',1),connect_args={'server_settings':{'role':'platform_voice'}})
    repository=PostgresVoiceRepository(url,engine=engine)
    try:
        assert await consume_voice_simulation(repository,'native-flow-fixture')
    finally:
        await repository.close()
asyncio.run(main())
`;
    execFileSync("uv", ["run", "--no-sync", "python", "-c", script], {
      cwd: root,
      stdio: "pipe",
      env: {
        ...process.env,
        TEST_DATABASE_URL: testDatabaseUrl,
        ENABLE_REAL_TELEPHONY: "false",
        ENABLE_REAL_WHATSAPP: "false",
        ENABLE_REAL_VOICE_PROVIDERS: "false",
      },
    });
    await admin`UPDATE ops.jobs SET available_at=CURRENT_TIMESTAMP WHERE reference_id=${result.runId}::uuid`;
    await runWorker("canonical-voice-resume");
    expect(
      (
        await admin`SELECT status FROM automation.flow_runs WHERE id=${result.runId}::uuid`
      )[0]?.status,
    ).toBe("succeeded");
    expect(
      (
        await admin`SELECT flow_id FROM sessions WHERE contact_id=${result.contact}::uuid`
      )[0]?.flow_id,
    ).toBe(retainedId);
    expect(
      await admin`SELECT id FROM automation.handoffs WHERE contact_id=${result.contact}::uuid`,
    ).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  }, 30_000);

  it.each([
    "success",
    "revoked-actor",
    "failed-child",
    "expired",
    "invalid-mode",
  ])(
    "canonical messaging path handles %s without premature handoff",
    async (scenario) => {
      const key = randomUUID();
      const result = await web.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
        const inbound = await ingestSimulatedInbound(tx, userId, {
          providerEventId: key,
          providerMessageId: key,
          from: `+1202555019${String(["success", "revoked-actor", "failed-child", "expired", "invalid-mode"].indexOf(scenario))}`,
          profileName: "Fictional canonical recipient",
          text: "A fixture only",
        });
        const contact = (
          await tx`SELECT contact_id FROM messaging.conversations WHERE id=${inbound.conversationId}::uuid`
        )[0]?.contact_id as string;
        await tx`UPDATE crm.contacts SET whatsapp_consent='granted' WHERE id=${contact}::uuid`;
        const agent = await createAgentProfileDraft(tx, userId, {
          name: `Agent ${key}`,
          systemPrompt: "Fictional safe agent",
          channels: ["whatsapp"],
        });
        await publishAgentProfile(tx, userId, agent);
        const agentVersion = (
          await tx`SELECT id FROM agents.agent_profile_versions WHERE agent_profile_id=${agent}::uuid`
        )[0]?.id as string;
        const definition = await createCanonicalFlowDraft(
          tx,
          userId,
          `Flow ${key}`,
          agentVersion,
          {
            schemaVersion: "1.0",
            channels: ["whatsapp"],
            nodes: [
              { id: "start", type: "start" },
              {
                id: "crm",
                type: "crm.update",
                configuration: { field: "company", value: "Fixture company" },
              },
              {
                id: "send",
                type: "message.send",
                configuration: {
                  kind: "template",
                  template_name: "hello_world",
                  language: "en_US",
                  variables: { "10": "ten", "2": "two", "1": "one" },
                },
              },
              {
                id: "handoff",
                type: "handoff",
                configuration: { reason: "Fictional completed delivery" },
              },
              { id: "end", type: "end" },
            ],
            edges: [
              { id: "a", source: "start", target: "crm" },
              { id: "b", source: "crm", target: "send" },
              { id: "c", source: "send", target: "handoff" },
              { id: "d", source: "handoff", target: "end" },
            ],
          },
        );
        expect(await publishExecutableFlow(tx, userId, definition)).toBe(true);
        const runId = await queueCanonicalSimulation(
          tx,
          userId,
          definition,
          inbound.conversationId,
          "whatsapp",
          key,
        );
        expect(
          await queueCanonicalSimulation(
            tx,
            userId,
            definition,
            inbound.conversationId,
            "whatsapp",
            key,
          ),
        ).toBe(runId);
        await expect(
          queueCanonicalSimulation(
            tx,
            userId,
            definition,
            randomUUID(),
            "whatsapp",
            key,
          ),
        ).rejects.toThrow("idempotency key conflict");
        return { runId, contact };
      });
      const simulator = new SimulatorWhatsAppProvider();
      const simulatorSend = vi.spyOn(simulator, "send");
      const store = createMessagingStore(workerUrl, "canonical-worker", {
        simulator,
        meta: { name: "meta", send },
      });
      try {
        if (scenario === "revoked-actor")
          await admin`UPDATE users SET status='disabled' WHERE id=${userId}::uuid`;
        if (scenario === "expired")
          await admin`UPDATE automation.flow_runs SET created_at=CURRENT_TIMESTAMP-INTERVAL '16 minutes' WHERE id=${result.runId}::uuid`;
        if (scenario === "invalid-mode")
          await admin`UPDATE ops.jobs SET payload='{"mode":"meta"}' WHERE reference_id=${result.runId}::uuid`;
        await store.processAvailable();
        if (["revoked-actor", "expired", "invalid-mode"].includes(scenario)) {
          expect(
            (
              await admin`SELECT status FROM automation.flow_runs WHERE id=${result.runId}::uuid`
            )[0]?.status,
          ).toBe("failed");
          expect(
            await admin`SELECT id FROM automation.flow_step_runs WHERE flow_run_id=${result.runId}::uuid`,
          ).toHaveLength(0);
          expect(simulatorSend).not.toHaveBeenCalled();
          expect(send).not.toHaveBeenCalled();
          return;
        }
        expect(
          (
            await admin`SELECT status FROM automation.flow_runs WHERE id=${result.runId}::uuid`
          )[0]?.status,
        ).toBe("waiting");
        expect(
          await admin`SELECT id FROM automation.handoffs WHERE contact_id=${result.contact}::uuid`,
        ).toHaveLength(0);
        if (scenario === "failed-child") {
          await admin`UPDATE ops.jobs SET status='dead' WHERE id IN (
          SELECT (output_metadata->>'jobId')::uuid FROM automation.flow_step_runs
          WHERE flow_run_id=${result.runId}::uuid AND status='waiting')`;
          await admin`UPDATE ops.jobs SET available_at=CURRENT_TIMESTAMP WHERE reference_id=${result.runId}::uuid`;
          await store.processAvailable();
          expect(
            (
              await admin`SELECT status FROM automation.flow_runs WHERE id=${result.runId}::uuid`
            )[0]?.status,
          ).toBe("failed");
          expect(
            await admin`SELECT id FROM automation.handoffs WHERE contact_id=${result.contact}::uuid`,
          ).toHaveLength(0);
          expect(simulatorSend).not.toHaveBeenCalled();
          expect(send).not.toHaveBeenCalled();
          return;
        }
        await store.processAvailable();
        await admin`UPDATE ops.jobs SET available_at=CURRENT_TIMESTAMP WHERE reference_id=${result.runId}::uuid`;
        await store.processAvailable();
        expect(
          (
            await admin`SELECT status FROM automation.flow_runs WHERE id=${result.runId}::uuid`
          )[0]?.status,
        ).toBe("succeeded");
        expect(
          await admin`SELECT id FROM automation.flow_step_runs WHERE flow_run_id=${result.runId}::uuid AND status='succeeded'`,
        ).toHaveLength(5);
        expect(
          await admin`SELECT id FROM automation.handoffs WHERE contact_id=${result.contact}::uuid`,
        ).toHaveLength(1);
        expect(
          (
            await admin`SELECT company FROM crm.contacts WHERE id=${result.contact}::uuid`
          )[0]?.company,
        ).toBe("Fixture company");
        expect(simulatorSend.mock.calls[0]?.[0].delivery).toMatchObject({
          kind: "template",
          parameters: ["one", "two", "ten"],
        });
        expect(send).not.toHaveBeenCalled();
      } finally {
        await admin`UPDATE users SET status='active' WHERE id=${userId}::uuid`;
        await store.close();
      }
    },
  );

  it("completes inbound WhatsApp → CRM → voice worker → WhatsApp follow-up without providers", async () => {
    const key = randomUUID();
    const inbound = await web.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant', ${tenantId}, true),
                      set_config('app.current_user', ${userId}, true)`;
      return ingestSimulatedInbound(tx, userId, {
        providerEventId: key,
        providerMessageId: key,
        from: "+12025550189",
        profileName: "Fictional cross-channel caller",
        text: "Please call the simulator",
      });
    });
    const contactId = (
      await admin`SELECT contact_id FROM messaging.conversations
      WHERE id = ${inbound.conversationId}::uuid`
    )[0]?.contact_id as string;
    await admin`UPDATE crm.contacts SET voice_consent='granted', whatsapp_consent='granted'
      WHERE id=${contactId}::uuid`;
    const admit = () =>
      web.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant', ${tenantId}, true),
                      set_config('app.current_user', ${userId}, true)`;
        return queueWhatsAppTriggeredCall(
          tx,
          userId,
          inbound.conversationId,
          key,
        );
      });
    const job = await admit();
    expect((await admit()).queued).toBe(false);
    const script = `
import asyncio, os
from sqlalchemy.ext.asyncio import create_async_engine
from control_api.voice import PostgresVoiceRepository
from control_api.voice_jobs import consume_voice_simulation
async def main():
    url = os.environ['TEST_DATABASE_URL']
    engine = create_async_engine(url.replace('postgresql://', 'postgresql+asyncpg://', 1), connect_args={'server_settings': {'role': 'platform_voice'}})
    repository = PostgresVoiceRepository(url, engine=engine)
    try:
        assert await consume_voice_simulation(repository, 'cross-language-fixture')
    finally:
        await repository.close()
asyncio.run(main())
`;
    execFileSync("uv", ["run", "--no-sync", "python", "-c", script], {
      cwd: root,
      stdio: "pipe",
      env: {
        ...process.env,
        TEST_DATABASE_URL: testDatabaseUrl,
        ENABLE_REAL_TELEPHONY: "false",
        ENABLE_REAL_WHATSAPP: "false",
        ENABLE_REAL_VOICE_PROVIDERS: "false",
      },
    });
    expect(
      (await admin`SELECT status FROM ops.jobs WHERE id=${job.jobId}::uuid`)[0]
        ?.status,
    ).toBe("succeeded");
    const session = (
      await admin`SELECT session_id FROM sessions WHERE contact_id=${contactId}::uuid`
    )[0];
    expect(session).toBeDefined();
    const followup = await enqueue(session?.session_id as string);
    await runWorker("cross-language-followup");
    expect(
      (
        await admin`SELECT status FROM ops.jobs WHERE id=${followup.jobId}::uuid`
      )[0]?.status,
    ).toBe("succeeded");
    const activity = await web.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return listContactActivity(tx, contactId);
    });
    expect(activity.length).toBeGreaterThanOrEqual(3);
    expect(send).not.toHaveBeenCalled();
  }, 30_000);

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
