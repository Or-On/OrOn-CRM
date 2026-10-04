import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  createKnowledgeDraft,
  changeKnowledgePublication,
} from "./knowledge.js";
import { createAgentProfileDraft } from "./cross-channel.js";
import { retrieveAgentKnowledge } from "./knowledge-retrieval.js";

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("required synthetic fixture value missing");
  return value;
}

const url = process.env.CRM_TEST_DATABASE_URL;
class RollbackFixture extends Error {}
describe.skipIf(!url)(
  "FTS retrieval with real PostgreSQL tenant boundaries",
  () => {
    it("returns relevant document-only text, blocks other tenant/agent and revocation", async () => {
      const target = new URL(required(url));
      if (
        target.hostname !== "127.0.0.1" ||
        target.port !== "55480" ||
        !/^\/oron_(?:ui_preview|crm|knowledge)_[a-f0-9]+$/u.test(
          target.pathname,
        )
      )
        throw new Error("owned local fictional database required");
      const db = postgres(required(url), { max: 1, prepare: false });
      try {
        await expect(
          db.begin(async (sql) => {
            const fixtures: {
              tenantId: string;
              userId: string;
              versionId: string;
              documentId: string;
            }[] = [];
            for (let i = 0; i < 2; i++) {
              const tenantId = randomUUID(),
                userId = randomUUID();
              await sql`INSERT INTO public.tenants(id,name,slug,status) VALUES(${tenantId}::uuid,'Fictional retrieval',${`retrieval-${tenantId}`},'active')`;
              await sql`INSERT INTO public.users(id,email,display_name,status) VALUES(${userId}::uuid,${`${userId}@example.invalid`},'Fictional reviewer','active')`;
              await sql`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'owner')`;
              await sql`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.current_user',${userId},true),set_config('app.current_role','owner',true)`;
              await expect(
                createKnowledgeDraft(sql, userId, {
                  title: "Content-only default off",
                  content: "משלוחים",
                  facts: [],
                  validFrom: "2020-01-01T00:00:00Z",
                  validUntil: null,
                }),
              ).rejects.toThrow("provide between 1 and 40");
              await sql`INSERT INTO platform.tenant_remediation_flags(tenant_id,flag_key,enabled) VALUES(${tenantId}::uuid,'retrieval_fts',true)`;
              await expect(
                createKnowledgeDraft(sql, userId, {
                  title: "Empty content refused",
                  content: " ",
                  facts: [],
                  validFrom: "2020-01-01T00:00:00Z",
                  validUntil: null,
                }),
              ).rejects.toThrow();
              const documentId = await createKnowledgeDraft(sql, userId, {
                title: "Fictional logistics",
                content: "משלוחים מגיעים ביום ראשון",
                facts: [],
                validFrom: "2020-01-01T00:00:00Z",
                validUntil: null,
              });
              await sql`UPDATE platform.tenant_remediation_flags SET enabled=false WHERE tenant_id=${tenantId}::uuid AND flag_key='retrieval_fts'`;
              await expect(
                changeKnowledgePublication(sql, userId, documentId, "publish"),
              ).rejects.toThrow("no eligible approved statements");
              await sql`UPDATE platform.tenant_remediation_flags SET enabled=true WHERE tenant_id=${tenantId}::uuid AND flag_key='retrieval_fts'`;
              await changeKnowledgePublication(
                sql,
                userId,
                documentId,
                "publish",
              );
              const sources = await sql<
                { source_id: string }[]
              >`SELECT source_id FROM agents.knowledge_documents WHERE id=${documentId}::uuid`;
              const profile = await createAgentProfileDraft(sql, userId, {
                name: "Fictional retrieval agent",
                systemPrompt: "Use approved knowledge",
                locale: "he",
                channels: ["whatsapp"],
              });
              const versions = await sql<
                { id: string }[]
              >`UPDATE agents.agent_profile_versions SET knowledge_configuration=${sql.json({ schemaVersion: "1.0", sourceIds: [required(sources[0]).source_id] })},published_at=clock_timestamp(),validation_status='valid' WHERE agent_profile_id=${profile}::uuid RETURNING id`;
              fixtures.push({
                tenantId,
                userId,
                versionId: required(versions[0]).id,
                documentId,
              });
            }
            const first = required(fixtures[0]),
              second = required(fixtures[1]);
            await sql`SET LOCAL ROLE platform_web`;
            await sql`SELECT set_config('app.current_tenant',${first.tenantId},true),set_config('app.current_user',${first.userId},true),set_config('app.current_role','owner',true)`;
            const input = {
              tenantId: first.tenantId,
              agentVersionId: first.versionId,
              question: "משלוחים",
            };
            const hits = await retrieveAgentKnowledge(sql, input);
            expect(hits).toHaveLength(1);
            expect(hits[0]?.content).toContain("משלוחים");
            expect(hits[0]?.facts).toEqual([]);
            expect(
              await retrieveAgentKnowledge(sql, {
                ...input,
                question: "חשבונית",
              }),
            ).toEqual([]);
            expect(
              await retrieveAgentKnowledge(sql, {
                ...input,
                agentVersionId: second.versionId,
              }),
            ).toEqual([]);
            expect(
              await retrieveAgentKnowledge(sql, {
                ...input,
                tenantId: second.tenantId,
                agentVersionId: second.versionId,
              }),
            ).toEqual([]);
            await changeKnowledgePublication(
              sql,
              first.userId,
              first.documentId,
              "revoke",
            );
            expect(await retrieveAgentKnowledge(sql, input)).toEqual([]);
            throw new RollbackFixture();
          }),
        ).rejects.toBeInstanceOf(RollbackFixture);
      } finally {
        await db.end({ timeout: 2 });
      }
    });
  },
);
