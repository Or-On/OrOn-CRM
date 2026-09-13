import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  archiveAutomation,
  createAutomationDraft,
  listAutomations,
  renameAutomation,
} from "./automations.js";
import {
  archiveAgentProfile,
  createAgentProfileDraft,
  listAgentProfiles,
  publishAgentProfile,
  renameAgentProfile,
  setDefaultWhatsAppAgent,
} from "./cross-channel.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;

class ExpectedRollback extends Error {}

describe.skipIf(databaseUrl === undefined)(
  "agent and flow archival management with PostgreSQL RLS",
  () => {
    it("renames, defaults, and archives active definitions while retaining versions", async () => {
      if (databaseUrl === undefined)
        throw new Error("CRM_TEST_DATABASE_URL is required");
      const target = new URL(databaseUrl);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))
        throw new Error(
          "management integration tests require localhost PostgreSQL",
        );
      const database = postgres(databaseUrl, { max: 1, prepare: false });
      try {
        await expect(
          database.begin(async (sql) => {
            const tenantId = randomUUID();
            const userId = randomUUID();
            await sql`
              INSERT INTO tenants(id,name,slug,status)
              VALUES(${tenantId}::uuid,'Fictional management tenant',
                     ${`management-${tenantId}`},'active')
            `;
            await sql`
              INSERT INTO users(id,email,display_name,status)
              VALUES(${userId}::uuid,
                     ${`management-${userId}@example.invalid`},
                     'Fictional owner','active')
            `;
            await sql`
              INSERT INTO memberships(tenant_id,user_id,role)
              VALUES(${tenantId}::uuid,${userId}::uuid,'owner')
            `;
            await sql`
              INSERT INTO crm.tenant_settings(tenant_id)
              VALUES(${tenantId}::uuid)
            `;
            await sql`SET LOCAL ROLE platform_web`;
            await sql`
              SELECT set_config('app.current_tenant',${tenantId},true),
                     set_config('app.current_user',${userId},true),
                     set_config('app.current_role','owner',true)
            `;

            const agentId = await createAgentProfileDraft(sql, userId, {
              name: "Fictional WhatsApp agent",
              systemPrompt: "Help fictional customers safely.",
              channels: ["whatsapp"],
            });
            expect(await publishAgentProfile(sql, userId, agentId)).toBe(true);
            expect(await setDefaultWhatsAppAgent(sql, userId, agentId)).toBe(
              true,
            );
            expect(
              await renameAgentProfile(sql, userId, agentId, "AI Agent"),
            ).toBe(true);
            expect(await listAgentProfiles(sql)).toEqual([
              expect.objectContaining({
                id: agentId,
                isDefaultWhatsApp: true,
                name: "AI Agent",
              }),
            ]);

            const flowId = await createAutomationDraft(
              sql,
              userId,
              "Fictional flow",
            );
            expect(
              await renameAutomation(sql, userId, flowId, "Customer flow"),
            ).toBe(true);
            expect(await listAutomations(sql)).toEqual([
              expect.objectContaining({ id: flowId, name: "Customer flow" }),
            ]);
            expect(await archiveAutomation(sql, userId, flowId)).toBe(true);
            expect(await listAutomations(sql)).toEqual([]);

            expect(await archiveAgentProfile(sql, userId, agentId)).toBe(
              "archived",
            );
            expect(await listAgentProfiles(sql)).toEqual([]);
            expect(
              await sql<{ count: number }[]>`
                SELECT count(*)::integer AS count
                FROM agents.agent_profile_versions
                WHERE agent_profile_id=${agentId}::uuid
              `,
            ).toEqual([{ count: 1 }]);
            expect(
              await sql<{ count: number }[]>`
                SELECT count(*)::integer AS count
                FROM automation.flow_versions
                WHERE flow_definition_id=${flowId}::uuid
              `,
            ).toEqual([{ count: 1 }]);
            const settings = await sql<
              { whatsapp_ai_agent_profile_id: string | null }[]
            >`
              SELECT whatsapp_ai_agent_profile_id
              FROM crm.tenant_settings
              WHERE tenant_id=${tenantId}::uuid
            `;
            expect(settings[0]?.whatsapp_ai_agent_profile_id).toBeNull();
            throw new ExpectedRollback();
          }),
        ).rejects.toBeInstanceOf(ExpectedRollback);
      } finally {
        await database.end({ timeout: 2 });
      }
    });
  },
);
