import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ingestSimulatedInbound } from "@or-on/crm";
import { createMessagingStore } from "../src/database.js";
import { SimulatorWhatsAppProvider } from "../src/providers.js";

// Explicit opt-in. Creates/drops only its own UUID-named database; fictional
// data; the simulator provider only — no real WhatsApp or telephony.
const sourceUrl = process.env.CROSS_CHANNEL_TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
const caller = "+972502345678";

const policy = {
  version: 1,
  requiredIntakeFields: ["customerName", "faultDescription", "urgency"],
  photoPolicy: "requested",
  selfAssignmentEnabled: true,
  requiredReportFields: ["diagnosis", "workPerformed"],
  inquiry: { openOnFirstContact: true },
  whatsappFollowUp: {
    enabled: true,
    trigger: "call_ended",
    requestPhoto: true,
    consent: "in_call_agreement",
  },
};

describe.skipIf(sourceUrl === undefined)(
  "phone inquiry WhatsApp follow-up through the real worker",
  () => {
    const databaseName = `oron_intake_followup_${randomUUID().replaceAll("-", "")}`;
    let maintenance: postgres.Sql;
    let admin: postgres.Sql;
    let web: postgres.Sql;
    let workerUrl: string;
    const cleanup: (() => Promise<void>)[] = [];

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
        await maintenance.unsafe(
          `DROP DATABASE "${databaseName}" WITH (FORCE)`,
        );
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
      for (const feature of [
        "contacts",
        "agents",
        "voice",
        "whatsapp",
        "tickets",
        "technicians",
      ])
        await admin`
          INSERT INTO platform.tenant_feature_entitlements
            (tenant_id, feature_key, available, enabled, granted_at)
          VALUES (${tenantId}::uuid, ${feature}, true, true, CURRENT_TIMESTAMP)
          ON CONFLICT (tenant_id, feature_key) DO UPDATE SET available=true, enabled=true
        `;
      await admin`
        INSERT INTO platform.tenant_feature_entitlements
          (tenant_id, feature_key, available, enabled, configuration, granted_at)
        VALUES (${tenantId}::uuid, 'field_service', true, true,
                ${admin.json({ workflow: policy })}, CURRENT_TIMESTAMP)
        ON CONFLICT (tenant_id, feature_key) DO UPDATE
          SET available=true, enabled=true, configuration=EXCLUDED.configuration
      `;
      await admin`
        INSERT INTO service.tenant_configuration (tenant_id, enabled)
        VALUES (${tenantId}::uuid, true)
        ON CONFLICT (tenant_id) DO UPDATE SET enabled=true
      `;
      url.searchParams.set("options", "-c role=platform_web");
      web = postgres(url.toString(), { max: 1 });
      cleanup.push(() => web.end());
      url.searchParams.set("options", "-c role=platform_messaging");
      workerUrl = url.toString();
    }, 180_000);

    afterAll(async () => {
      for (const close of cleanup.reverse()) await close();
    });

    it("renders, addresses and delivers the follow-up, then attaches the reply to the same inquiry", async () => {
      const contactId = randomUUID();
      const identityId = randomUUID();
      const sessionId = randomUUID();
      const profileId = randomUUID();
      const agentId = randomUUID();
      await admin`INSERT INTO crm.contacts (id, tenant_id, name) VALUES (${contactId}::uuid, ${tenantId}::uuid, ${caller})`;
      await admin`
        INSERT INTO crm.contact_channel_identities
          (id, tenant_id, contact_id, channel, normalized_value, validation_status, is_primary)
        VALUES (${identityId}::uuid, ${tenantId}::uuid, ${contactId}::uuid, 'phone', ${caller}, 'valid', true)
      `;
      await admin`INSERT INTO agents.agent_profiles (id, tenant_id, name) VALUES (${profileId}::uuid, ${tenantId}::uuid, 'Fictional intake agent')`;
      await admin`
        INSERT INTO agents.agent_profile_versions
          (id, tenant_id, agent_profile_id, version, system_prompt, locale,
           channel_capabilities, tool_permissions, validation_status, published_at)
        VALUES (${agentId}::uuid, ${tenantId}::uuid, ${profileId}::uuid, 1, 'Fictional.', 'he',
                ARRAY['voice','whatsapp']::text[], '["service.intake"]'::jsonb, 'valid', CURRENT_TIMESTAMP)
      `;
      // The operator the tenant approved for automated WhatsApp is the
      // accountable sender, as for the existing post-call follow-up.
      await admin`
        UPDATE crm.tenant_settings
        SET whatsapp_ai_agent_profile_id=${profileId}::uuid,
            whatsapp_ai_enabled_by_user_id=${userId}::uuid,
            whatsapp_ai_enabled_at=CURRENT_TIMESTAMP,
            business_name='Fictional Cooling', locale='he'
        WHERE tenant_id=${tenantId}::uuid
      `;
      await admin`
        INSERT INTO public.sessions (session_id, tenant_id, contact_id, provider, direction, room, status, flow_id)
        VALUES (${sessionId}::uuid, ${tenantId}::uuid, ${contactId}::uuid, 'livekit', 'inbound',
                ${`inbound-${sessionId}`}, 'started', ${randomUUID()}::uuid)
      `;
      await admin`
        INSERT INTO public.session_events (tenant_id, session_id, sequence, event_type, payload)
        VALUES (${tenantId}::uuid, ${sessionId}::uuid, 0, 'voice.agent.binding.v1',
                ${admin.json({ agent_version_id: agentId, caller_identity_id: identityId })})
      `;
      // A simulator channel exists as it would for a configured tenant.
      await web.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant', ${tenantId}, true),
                        set_config('app.current_user', ${userId}, true)`;
        await tx`
          INSERT INTO messaging.channels (tenant_id, kind, provider, provider_account_id, display_address, status, configuration)
          VALUES (${tenantId}::uuid, 'whatsapp', 'simulator', ${`simulator:${tenantId}`}, 'WhatsApp simulator', 'active', '{"mode":"simulator"}'::jsonb)
          ON CONFLICT (provider, provider_account_id) WHERE provider_account_id IS NOT NULL DO NOTHING
        `;
      });

      // The voice runtime's calls, as the voice role.
      const intakeId = await admin.begin(async (tx) => {
        await tx`SET LOCAL ROLE platform_voice`;
        await tx`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        const [opened] = await tx<
          { receipt: { intakeId: string; status: string } }[]
        >`
          SELECT service.open_voice_inquiry(${sessionId}::uuid) AS receipt
        `;
        expect(opened?.receipt.status).toBe("open");
        await tx`
          SELECT service.capture_service_intake(${sessionId}::uuid,
            ${tx.json({ customerName: "דנה", faultDescription: "המקרר לא מקרר" })}, false)
        `;
        const [request] = await tx<{ receipt: { status: string } }[]>`
          SELECT service.request_intake_followup(${sessionId}::uuid, true) AS receipt
        `;
        expect(request?.receipt.status).toBe("deferred");
        return opened?.receipt.intakeId ?? "";
      });
      // The caller hangs up before confirming; the inquiry stays visible and
      // the follow-up is queued by the call-end settlement.
      await admin`UPDATE public.sessions SET status='ended', ended_at=CURRENT_TIMESTAMP WHERE session_id=${sessionId}::uuid`;

      const sent: string[] = [];
      const provider = new SimulatorWhatsAppProvider();
      const recording = {
        name: "simulator" as const,
        async send(request: Parameters<typeof provider.send>[0]) {
          if (request.delivery.kind === "text")
            sent.push(request.delivery.text);
          return provider.send(request);
        },
      };
      const store = createMessagingStore(
        workerUrl,
        `followup-test-${randomUUID()}`,
        { simulator: recording, meta: recording },
        undefined,
        { simulatorEnabled: true },
      );
      try {
        for (let round = 0; round < 6; round += 1)
          await store.processAvailable();
      } finally {
        await store.close();
      }

      const [draft] = await admin<
        {
          followup_status: string;
          followup_message_id: string | null;
          conversation_id: string | null;
        }[]
      >`SELECT followup_status, followup_message_id, conversation_id FROM service.intake_drafts WHERE id=${intakeId}::uuid`;
      expect(draft?.followup_status).toBe("admitted");
      expect(draft?.conversation_id).not.toBeNull();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("תודה שפנית לFictional Cooling");
      expect(sent[0]).toContain("המקרר לא מקרר");
      expect(sent[0]).toContain("תמונה של התקלה");
      const [message] = await admin<{ status: string; sender_type: string }[]>`
        SELECT status, sender_type FROM messaging.messages WHERE id=${draft?.followup_message_id ?? ""}::uuid
      `;
      expect(message?.sender_type).toBe("system");
      expect(["sent", "delivered"]).toContain(message?.status);

      // The customer answers on WhatsApp; the reply lands on the same inquiry.
      await web.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant', ${tenantId}, true),
                        set_config('app.current_user', ${userId}, true)`;
        await ingestSimulatedInbound(tx, userId, {
          providerEventId: `reply-${randomUUID()}`,
          providerMessageId: `reply-${randomUUID()}`,
          from: caller,
          profileName: "Fictional caller",
          text: "זה המקרר בחדר האחורי",
        });
      });
      const [linked] = await admin<{ replies: number; replied: Date | null }[]>`
        SELECT count(*)::int AS replies,
          (SELECT customer_replied_at FROM service.intake_drafts WHERE id=${intakeId}::uuid) AS replied
        FROM service.intake_messages im JOIN messaging.messages m ON m.id=im.message_id
        WHERE im.intake_draft_id=${intakeId}::uuid AND m.direction='inbound'
      `;
      expect(linked?.replies).toBe(1);
      expect(linked?.replied).not.toBeNull();
      const kinds = await admin<{ kind: string }[]>`
        SELECT event.kind FROM support.ticket_events event
        JOIN support.tickets ticket ON ticket.id=event.ticket_id
        WHERE ticket.intake_draft_id=${intakeId}::uuid ORDER BY event.sequence
      `;
      expect(kinds.map((row) => row.kind)).toEqual([
        "opened",
        "customer_update",
        "call_outcome",
        "agent_message",
        "agent_message",
        "customer_message",
      ]);
    }, 120_000);
  },
);
