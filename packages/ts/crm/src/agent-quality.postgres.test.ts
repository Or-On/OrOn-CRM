import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { defaultAgentQuality } from "./agent-quality.js";
import {
  createAgentQualityDraft,
  evaluateAgentQuality,
  listAgentQualityVersions,
  listAgentVoiceBindings,
} from "./agent-quality-store.js";
import {
  createAgentProfileDraft,
  createCanonicalFlowDraft,
  publishAgentProfile,
  publishCanonicalFlow,
} from "./cross-channel.js";
import {
  changeKnowledgePublication,
  createKnowledgeDraft,
  listKnowledgeVersions,
  loadEligibleAgentKnowledge,
} from "./knowledge.js";

const databaseUrl = process.env.READINESS_POSTGRES_URL;
class RollbackFixture extends Error {}
function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("fixture row required");
  return row;
}
async function isolated(
  work: (
    sql: postgres.TransactionSql,
    tenantId: string,
    userId: string,
  ) => Promise<void>,
) {
  if (!databaseUrl) throw new Error("isolated readiness database required");
  const target = new URL(databaseUrl);
  if (
    target.hostname !== "127.0.0.1" ||
    target.port !== "55439" ||
    target.pathname !== "/oron_readiness" ||
    target.username !== "platform_migrator"
  )
    throw new Error("only the owned readiness fixture is permitted");
  const database = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await expect(
      database.begin(async (sql) => {
        const tenantId = randomUUID();
        const userId = randomUUID();
        await sql`INSERT INTO tenants(id,name,slug,status) VALUES(${tenantId}::uuid,'Fictional quality tenant',${`quality-${tenantId}`},'active')`;
        await sql`INSERT INTO users(id,email,display_name,is_superuser,status) VALUES(${userId}::uuid,${`quality-${userId}@example.invalid`},'Fictional reviewer',false,'active')`;
        await sql`INSERT INTO memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'owner')`;
        await sql`SET LOCAL ROLE platform_web`;
        await sql`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.current_user',${userId},true),set_config('app.current_role','owner',true)`;
        await work(sql, tenantId, userId);
        throw new RollbackFixture();
      }),
    ).rejects.toBeInstanceOf(RollbackFixture);
  } finally {
    await database.end({ timeout: 2 });
  }
}
const draft = (value = "שעות הפעילות הן 09:00–17:00.") => ({
  title: "Fictional hours",
  content: "Approved fictional business hours",
  facts: [{ factKey: "opening_hours", value }],
  validFrom: "2026-01-01T00:00:00Z",
  validUntil: null,
});

describe.skipIf(!databaseUrl)(
  "approved knowledge and profile persistence with real PostgreSQL RLS",
  () => {
    it("runs draft → publish knowledge → select → test → publish agent → restore as a new version", async () =>
      isolated(async (sql, _tenantId, userId) => {
        const documentId = await createKnowledgeDraft(sql, userId, draft());
        const sourceId = first(await listKnowledgeVersions(sql)).sourceId;
        const profileId = await createAgentProfileDraft(sql, userId, {
          name: "Fictional quality agent",
          systemPrompt: "Ask useful questions.",
          locale: "he",
          channels: ["voice", "whatsapp"],
        });
        const original = first(await listAgentQualityVersions(sql, profileId));
        expect(original.quality.callerAddressDefault).toBe("unknown");
        await changeKnowledgePublication(sql, userId, documentId, "publish");
        const versionId = await createAgentQualityDraft(
          sql,
          userId,
          profileId,
          {
            baseVersionId: original.id,
            latestVersionId: original.id,
            systemPrompt: original.systemPrompt,
            quality: {
              ...defaultAgentQuality,
              callerAddressDefault: "masculine",
            },
            sourceIds: [sourceId],
          },
        );
        expect(await publishAgentProfile(sql, userId, profileId)).toBe(false);
        const preview = await evaluateAgentQuality(sql, userId, profileId, {
          versionId,
          text: "מתי פתוח?",
          factKey: "opening_hours",
        });
        expect(preview).toMatchObject({
          mode: "deterministic-preview",
          response: first(draft().facts).value,
          recognizedText: null,
          providerCost: 0,
          audio: "pending-authorized-provider-evaluation",
        });
        expect(await publishAgentProfile(sql, userId, profileId)).toBe(true);
        expect(await loadEligibleAgentKnowledge(sql, versionId)).toHaveLength(
          1,
        );
        const restored = await createAgentQualityDraft(sql, userId, profileId, {
          baseVersionId: original.id,
          latestVersionId: versionId,
          systemPrompt: original.systemPrompt,
          quality: original.quality,
          sourceIds: [],
        });
        const versions = await listAgentQualityVersions(sql, profileId);
        expect(versions[0]).toMatchObject({
          id: restored,
          version: 3,
          quality: { callerAddressDefault: "unknown" },
          publishedAt: null,
        });
        expect(
          versions.find((version) => version.id === versionId)?.quality
            .callerAddressDefault,
        ).toBe("masculine");
        await expect(
          sql.savepoint(async (tx) => {
            await tx`UPDATE agents.agent_profile_versions SET system_prompt='changed' WHERE id=${versionId}::uuid`;
          }),
        ).rejects.toMatchObject({ code: "55000" });
      }));
    it("reports the pinned voice binding and never promotes a newer published version", async () =>
      isolated(async (sql, _tenantId, userId) => {
        const profileId = await createAgentProfileDraft(sql, userId, {
          name: "Fictional voice agent",
          systemPrompt: "את נציגת התמיכה של קו בדיוני.",
          locale: "he",
          channels: ["voice"],
        });
        const v1 = first(await listAgentQualityVersions(sql, profileId));
        expect(await listAgentVoiceBindings(sql, profileId)).toEqual([]);
        expect(await publishAgentProfile(sql, userId, profileId)).toBe(true);
        const definitionId = await createCanonicalFlowDraft(
          sql,
          userId,
          "Fictional voice line",
          v1.id,
          {
            schemaVersion: "1.0",
            channels: ["voice"],
            nodes: [
              { id: "start", type: "start" },
              {
                id: "call",
                type: "voice.call",
                configuration: { flowId: randomUUID(), flowVersion: 1 },
              },
              { id: "end", type: "end" },
            ],
            edges: [
              { id: "start-call", source: "start", target: "call" },
              { id: "call-end", source: "call", target: "end" },
            ],
          },
        );
        expect(await publishCanonicalFlow(sql, userId, definitionId)).toBe(
          true,
        );
        expect(await listAgentVoiceBindings(sql, profileId)).toMatchObject([
          {
            flowDefinitionId: definitionId,
            flowName: "Fictional voice line",
            agentVersionId: v1.id,
            agentVersion: 1,
            callable: true,
          },
        ]);

        // Edit the CRM prompt, test and publish v2: new calls must still use
        // v1 until a flow version bound to v2 is published.
        const v2 = await createAgentQualityDraft(sql, userId, profileId, {
          baseVersionId: v1.id,
          latestVersionId: v1.id,
          systemPrompt: "את נציגת התמיכה של קו בדיוני. עני בקצרה.",
          quality: v1.quality,
          sourceIds: [],
        });
        await evaluateAgentQuality(sql, userId, profileId, {
          versionId: v2,
          text: "מי אתם?",
        });
        expect(await publishAgentProfile(sql, userId, profileId)).toBe(true);
        expect(await listAgentVoiceBindings(sql, profileId)).toMatchObject([
          { agentVersionId: v1.id, agentVersion: 1, callable: true },
        ]);
      }));
    it("blocks published document/chunk mutation and role/tenant leakage; revocation is current for both runtimes", async () =>
      isolated(async (sql, tenantId, userId) => {
        const documentId = await createKnowledgeDraft(sql, userId, draft());
        const sourceId = first(await listKnowledgeVersions(sql)).sourceId;
        await changeKnowledgePublication(sql, userId, documentId, "publish");
        const profileId = await createAgentProfileDraft(sql, userId, {
          name: "Fictional access agent",
          systemPrompt: "Ask a question.",
          channels: ["voice"],
        });
        const original = first(await listAgentQualityVersions(sql, profileId));
        const versionId = await createAgentQualityDraft(
          sql,
          userId,
          profileId,
          {
            baseVersionId: original.id,
            latestVersionId: original.id,
            systemPrompt: original.systemPrompt,
            quality: original.quality,
            sourceIds: [sourceId],
          },
        );
        await evaluateAgentQuality(sql, userId, profileId, {
          versionId,
          text: "hours",
        });
        await publishAgentProfile(sql, userId, profileId);
        for (const statement of [
          () =>
            sql.savepoint(async (tx) => {
              await tx`UPDATE agents.knowledge_documents SET title='changed' WHERE id=${documentId}::uuid`;
            }),
          () =>
            sql.savepoint(async (tx) => {
              await tx`UPDATE agents.knowledge_chunks SET content='changed' WHERE document_id=${documentId}::uuid`;
            }),
          () =>
            sql.savepoint(async (tx) => {
              await tx`INSERT INTO agents.knowledge_chunks(tenant_id,document_id,ordinal,content) VALUES(${tenantId}::uuid,${documentId}::uuid,1,'new')`;
            }),
        ])
          await expect(statement()).rejects.toMatchObject({ code: "55000" });
        const viewerId = randomUUID();
        await sql`RESET ROLE`;
        await sql`INSERT INTO users(id,email,display_name,is_superuser,status) VALUES(${viewerId}::uuid,${`viewer-${viewerId}@example.invalid`},'Fictional viewer',false,'active')`;
        await sql`INSERT INTO memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${viewerId}::uuid,'viewer')`;
        await sql`SET LOCAL ROLE platform_web`;
        await sql`SELECT set_config('app.current_user',${viewerId},true)`;
        await expect(
          createKnowledgeDraft(sql, userId, draft("forbidden")),
        ).rejects.toMatchObject({ code: "42501" });
        await sql`SELECT set_config('app.current_user',${userId},true)`;
        for (const role of ["platform_voice", "platform_messaging"] as const) {
          await sql`RESET ROLE`;
          await sql.unsafe(`SET LOCAL ROLE ${role}`);
          expect(await loadEligibleAgentKnowledge(sql, versionId)).toHaveLength(
            1,
          );
          await sql`SELECT set_config('app.current_tenant',${randomUUID()},true)`;
          expect(await loadEligibleAgentKnowledge(sql, versionId)).toEqual([]);
          await sql`SELECT set_config('app.current_tenant',${tenantId},true)`;
        }
        await sql`RESET ROLE`;
        await sql`SET LOCAL ROLE platform_web`;
        await changeKnowledgePublication(sql, userId, documentId, "revoke");
        expect(await loadEligibleAgentKnowledge(sql, versionId)).toEqual([]);
        await expect(
          sql.savepoint(async (tx) => {
            await tx`UPDATE agents.knowledge_documents SET revoked_at=NULL WHERE id=${documentId}::uuid`;
          }),
        ).rejects.toMatchObject({ code: "55000" });
      }));
    it("does not fall back to an old publication after a newer version is revoked or not yet valid", async () =>
      isolated(async (sql, _tenantId, userId) => {
        const old = await createKnowledgeDraft(sql, userId, draft());
        const sourceId = first(await listKnowledgeVersions(sql)).sourceId;
        await changeKnowledgePublication(sql, userId, old, "publish");
        const profileId = await createAgentProfileDraft(sql, userId, {
          name: "Fictional freshness agent",
          systemPrompt: "Ask a question.",
          channels: ["voice"],
        });
        const original = first(await listAgentQualityVersions(sql, profileId));
        const versionId = await createAgentQualityDraft(
          sql,
          userId,
          profileId,
          {
            baseVersionId: original.id,
            latestVersionId: original.id,
            systemPrompt: original.systemPrompt,
            quality: original.quality,
            sourceIds: [sourceId],
          },
        );
        await evaluateAgentQuality(sql, userId, profileId, {
          versionId,
          text: "hours",
        });
        await publishAgentProfile(sql, userId, profileId);
        const future = await createKnowledgeDraft(sql, userId, {
          ...draft("שעות הפעילות הן 10:00–18:00."),
          sourceId,
          validFrom: "2099-01-01T00:00:00Z",
        });
        await changeKnowledgePublication(sql, userId, future, "publish");
        expect(await loadEligibleAgentKnowledge(sql, versionId)).toEqual([]);
        await changeKnowledgePublication(sql, userId, future, "revoke");
        expect(await loadEligibleAgentKnowledge(sql, versionId)).toEqual([]);
        const expired = await createKnowledgeDraft(sql, userId, {
          ...draft("שעות הפעילות הן 08:00–16:00."),
          sourceId,
          validFrom: "2025-01-01T00:00:00Z",
          validUntil: "2025-12-31T00:00:00Z",
        });
        await expect(
          changeKnowledgePublication(sql, userId, expired, "publish"),
        ).rejects.toThrow("publication state changed");
        // Model a historically valid publication that has expired by today's read;
        // no clock manipulation and no mutation of already published content.
        await sql`UPDATE agents.knowledge_documents SET published_at='2025-01-02T00:00:00Z' WHERE id=${expired}::uuid`;
        await sql`UPDATE agents.knowledge_sources SET status='published' WHERE id=${sourceId}::uuid`;
        expect(await loadEligibleAgentKnowledge(sql, versionId)).toEqual([]);
      }));
    it("blocks conflicting approved subjects and a stale editor without publishing an older draft", async () =>
      isolated(async (sql, _tenantId, userId) => {
        const firstDocument = await createKnowledgeDraft(sql, userId, draft());
        await changeKnowledgePublication(sql, userId, firstDocument, "publish");
        const secondDocument = await createKnowledgeDraft(
          sql,
          userId,
          draft("שעות הפעילות הן 10:00–18:00."),
        );
        await changeKnowledgePublication(
          sql,
          userId,
          secondDocument,
          "publish",
        );
        const sources = (await listKnowledgeVersions(sql)).map(
          (source) => source.sourceId,
        );
        const profileId = await createAgentProfileDraft(sql, userId, {
          name: "Fictional conflicting agent",
          systemPrompt: "Ask a useful question.",
          channels: ["voice"],
        });
        const original = first(await listAgentQualityVersions(sql, profileId));
        const payload = {
          baseVersionId: original.id,
          latestVersionId: original.id,
          systemPrompt: original.systemPrompt,
          quality: original.quality,
          sourceIds: sources,
        };
        const versionId = await createAgentQualityDraft(
          sql,
          userId,
          profileId,
          payload,
        );
        await expect(
          createAgentQualityDraft(sql, userId, profileId, payload),
        ).rejects.toThrow("agent version changed");
        const result = await evaluateAgentQuality(sql, userId, profileId, {
          versionId,
          text: "hours",
          factKey: "opening_hours",
        });
        expect(result.conflicts).toEqual(["opening_hours"]);
        expect(result.decision).toBe("clarification");
        expect(await publishAgentProfile(sql, userId, profileId)).toBe(false);
        expect(
          first(await listAgentQualityVersions(sql, profileId))
            .validationStatus,
        ).toBe("invalid");
      }));
  },
);
