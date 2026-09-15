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
  createCanonicalFlowDraft,
  listAgentProfiles,
  publishAgentProfile,
  publishCanonicalFlow,
  renameAgentProfile,
  setDefaultWhatsAppAgent,
  type CanonicalFlow,
} from "./cross-channel.js";
import { saveCanonicalFlowDraft } from "./flow-runtime.js";

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
              channels: ["voice", "whatsapp"],
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

            const [agentVersion] = await sql<{ id: string }[]>`
              SELECT id FROM agents.agent_profile_versions
              WHERE agent_profile_id=${agentId}::uuid
            `;
            if (agentVersion === undefined)
              throw new Error("agent version was not created");
            const canonicalFlow: CanonicalFlow = {
              schemaVersion: "1.0",
              channels: ["whatsapp"],
              nodes: [
                { id: "start", type: "start" },
                {
                  id: "message",
                  type: "message.send",
                  configuration: { text: "Fictional customer follow-up" },
                },
                { id: "end", type: "end" },
              ],
              edges: [
                { id: "start-message", source: "start", target: "message" },
                { id: "message-end", source: "message", target: "end" },
              ],
            };
            const canonicalFlowId = await createCanonicalFlowDraft(
              sql,
              userId,
              "Fictional editable flow",
              agentVersion.id,
              canonicalFlow,
            );
            expect(
              await publishCanonicalFlow(sql, userId, canonicalFlowId),
            ).toBe(true);
            const savedDraft = await saveCanonicalFlowDraft(
              sql,
              userId,
              canonicalFlowId,
              {
                schemaVersion: "1.0",
                channels: ["voice", "whatsapp"],
                nodes: [
                  { id: "start", label: "Edited follow-up", type: "start" },
                  { id: "end", type: "end" },
                ],
                edges: [{ id: "start-end", source: "start", target: "end" }],
              },
            );
            expect(savedDraft?.version).toBe(2);
            expect(savedDraft?.versionId).toMatch(
              /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu,
            );
            const canonicalVersions = await sql<
              {
                label: string | null;
                published_at: Date | null;
                version: number;
              }[]
            >`
              SELECT version, published_at, definition->'nodes'->0->>'label' AS label
              FROM automation.flow_versions
              WHERE flow_definition_id=${canonicalFlowId}::uuid
              ORDER BY version
            `;
            expect(canonicalVersions).toHaveLength(2);
            expect(canonicalVersions[0]).toMatchObject({
              label: null,
              version: 1,
            });
            expect(canonicalVersions[0]?.published_at).toBeInstanceOf(Date);
            expect(canonicalVersions[1]).toEqual({
              label: "Edited follow-up",
              published_at: null,
              version: 2,
            });
            expect(
              await sql<{ channel_capabilities: string[] }[]>`
                SELECT channel_capabilities
                FROM automation.flow_definitions
                WHERE id=${canonicalFlowId}::uuid
              `,
            ).toEqual([{ channel_capabilities: ["whatsapp"] }]);
            expect(
              await publishCanonicalFlow(sql, userId, canonicalFlowId),
            ).toBe(true);
            expect(
              await sql<{ channel_capabilities: string[] }[]>`
                SELECT channel_capabilities
                FROM automation.flow_definitions
                WHERE id=${canonicalFlowId}::uuid
              `,
            ).toEqual([{ channel_capabilities: ["voice", "whatsapp"] }]);
            expect(
              await sql<{ count: number }[]>`
                SELECT count(*)::integer AS count FROM audit.records
                WHERE action='flow.draft_saved'
                  AND target_id=${canonicalFlowId}::uuid
              `,
            ).toEqual([{ count: 1 }]);

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
