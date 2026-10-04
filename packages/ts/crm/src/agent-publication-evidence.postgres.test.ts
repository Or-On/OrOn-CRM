import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { defaultAgentQuality } from "./agent-quality.js";
import {
  createAgentQualityDraft,
  evaluateAgentQuality,
  listAgentQualityVersions,
} from "./agent-quality-store.js";
import {
  createAgentProfileDraft,
  publishAgentProfile,
} from "./cross-channel.js";
import {
  changeKnowledgePublication,
  createKnowledgeDraft,
  listKnowledgeVersions,
} from "./knowledge.js";
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("required synthetic fixture value missing");
  return value;
}

const url = process.env.CRM_TEST_DATABASE_URL;
class RollbackFixture extends Error {}
function first<T>(rows: readonly T[]): T {
  if (!rows[0]) throw Error("fixture missing");
  return rows[0];
}
async function fixture(
  work: (
    sql: postgres.TransactionSql,
    tenant: string,
    actors: Record<string, string>,
    foreign: string,
  ) => Promise<void>,
) {
  const parsed = new URL(required(url));
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "55480" ||
    !/^\/oron_(?:crm|ui_preview)_[a-f0-9]{32}$/u.test(parsed.pathname)
  )
    throw Error("owned independent fixture only");
  const db = postgres(required(url), { max: 1, prepare: false });
  try {
    await expect(
      db.begin(async (sql) => {
        const tenant = randomUUID(),
          foreign = randomUUID(),
          actors: Record<string, string> = {};
        for (const id of [tenant, foreign])
          await sql`INSERT INTO tenants(id,name,slug,status) VALUES(${id}::uuid,'Fictional publish review',${"publish-" + id},'active')`;
        for (const role of [
          "owner",
          "admin",
          "agent",
          "viewer",
          "technician",
          "inactive",
        ]) {
          const id = randomUUID();
          actors[role] = id;
          await sql`INSERT INTO users(id,email,display_name,is_superuser,status) VALUES(${id}::uuid,${id + "@example.invalid"},'Fictional quality reviewer',false,${role === "inactive" ? "inactive" : "active"})`;
          await sql`INSERT INTO memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${id}::uuid,${role === "inactive" ? "admin" : role})`;
        }
        await sql`SET LOCAL ROLE platform_web`;
        await sql`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${required(actors.owner)},true),set_config('app.current_role','owner',true)`;
        await work(sql, tenant, actors, foreign);
        throw new RollbackFixture();
      }),
    ).rejects.toBeInstanceOf(RollbackFixture);
  } finally {
    await db.end({ timeout: 2 });
  }
}
async function draft(
  sql: postgres.TransactionSql,
  actor: string,
  sourceIds: readonly string[] = [],
) {
  const profile = await createAgentProfileDraft(sql, actor, {
    name: "Fictional configuration preview",
    systemPrompt: "Ask for approved details.",
    locale: "en",
    channels: ["voice", "whatsapp"],
  });
  const initial = first(await listAgentQualityVersions(sql, profile));
  const version = await createAgentQualityDraft(sql, actor, profile, {
    baseVersionId: initial.id,
    latestVersionId: initial.id,
    systemPrompt: initial.systemPrompt,
    quality: defaultAgentQuality,
    sourceIds,
  });
  return { profile, version };
}
describe.skipIf(!url)(
  "publication authorization and honest quality evidence",
  () => {
    it("documents that deterministic metadata validation permits publication without any real-provider quality evidence", () =>
      fixture(async (sql, _tenant, actors) => {
        const d = await draft(sql, required(actors.owner));
        expect(
          await publishAgentProfile(sql, required(actors.owner), d.profile),
        ).toBe(false);
        const preview = await evaluateAgentQuality(
          sql,
          required(actors.owner),
          d.profile,
          { versionId: d.version, text: "Synthetic unknown business question" },
        );
        expect(preview).toMatchObject({
          mode: "deterministic-preview",
          decision: "clarification",
          providerCost: 0,
          recognizedText: null,
          timings: { sttMs: null, modelMs: null, ttsMs: null },
        });
        expect(preview.receipts).toEqual([]);
        expect(
          await publishAgentProfile(sql, required(actors.owner), d.profile),
        ).toBe(true);
        const version = first(await listAgentQualityVersions(sql, d.profile));
        expect(version.publishedAt).not.toBeNull();
        const receipts =
          await sql`SELECT id FROM audit.records WHERE target_id=${d.version}::uuid AND action='agent.provider_evaluation'`;
        expect(receipts).toHaveLength(0);
      }));
    it("rejects stored nonmanager, forged owner context, inactive manager and foreign tenant while permitting current admin", () =>
      fixture(async (sql, tenant, actors, foreign) => {
        const d = await draft(sql, required(actors.owner));
        await evaluateAgentQuality(sql, required(actors.owner), d.profile, {
          versionId: d.version,
          text: "Synthetic question",
        });
        for (const role of ["agent", "viewer", "technician", "inactive"]) {
          await sql`SELECT set_config('app.current_user',${required(actors[role])},true),set_config('app.current_role','owner',true)`;
          await expect(
            sql.savepoint((nested) =>
              publishAgentProfile(nested, required(actors[role]), d.profile),
            ),
          ).rejects.toMatchObject({ code: "42501" });
        }
        await sql`SELECT set_config('app.current_tenant',${foreign},true),set_config('app.current_user',${required(actors.owner)},true)`;
        await expect(
          sql.savepoint((nested) =>
            publishAgentProfile(nested, required(actors.owner), d.profile),
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await sql`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${required(actors.admin)},true),set_config('app.current_role','admin',true)`;
        expect(
          await publishAgentProfile(sql, required(actors.admin), d.profile),
        ).toBe(true);
      }));
    it("rechecks revoked knowledge at publication after a successful configuration preview", () =>
      fixture(async (sql, _tenant, actors) => {
        const document = await createKnowledgeDraft(
          sql,
          required(actors.owner),
          {
            title: "Fictional opening hours",
            content: "Approved synthetic business information",
            facts: [
              { factKey: "opening_hours", value: "Business hours 09:00-17:00" },
            ],
            validFrom: new Date(Date.now() - 86400000).toISOString(),
            validUntil: null,
          },
        );
        const source = first(await listKnowledgeVersions(sql)).sourceId;
        await changeKnowledgePublication(
          sql,
          required(actors.owner),
          document,
          "publish",
        );
        const d = await draft(sql, required(actors.owner), [source]);
        await evaluateAgentQuality(sql, required(actors.owner), d.profile, {
          versionId: d.version,
          text: "Synthetic hours question",
          factKey: "opening_hours",
        });
        await changeKnowledgePublication(
          sql,
          required(actors.owner),
          document,
          "revoke",
        );
        await expect(
          publishAgentProfile(sql, required(actors.owner), d.profile),
        ).rejects.toThrow(/revoked|expired|missing/);
        expect(
          first(await listAgentQualityVersions(sql, d.profile)).publishedAt,
        ).toBeNull();
      }));
  },
);
