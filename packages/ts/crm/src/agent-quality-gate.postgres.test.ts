import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  createAgentProfileDraft,
  publishAgentProfile,
} from "./cross-channel.js";
import { listAgentQualityVersions } from "./agent-quality-store.js";
import {
  assertAgentGoldenPublishable,
  getAgentGoldenWorkspace,
  requestAgentGoldenEvaluation,
} from "./agent-quality-gate.js";

const url = process.env.AGENT_QUALITY_GATE_TEST_DATABASE_URL;
class RollbackFixture extends Error {}

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw Error("required fictional gate fixture missing");
  return value;
}

describe.skipIf(!url)("pending golden gate actual PG API", () => {
  it("preserves gate-off reads, queues synthetic work as blocked and rejects enabled publication", async () => {
    const target = new URL(required(url));
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55480" ||
      !/^\/oron_(?:crm|ui_preview)_[a-f0-9]{32}$/u.test(target.pathname)
    )
      throw Error("owned loopback fictional gate fixture required");
    const db = postgres(required(url), { max: 1, prepare: false });
    try {
      await expect(
        db.begin(async (sql) => {
          const tenant = randomUUID();
          const owner = randomUUID();
          const viewer = randomUUID();
          await sql`INSERT INTO tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional gate API',${"gate-api-" + tenant},'active')`;
          for (const [id, role] of [
            [owner, "owner"],
            [viewer, "viewer"],
          ] as const) {
            await sql`INSERT INTO users(id,email,display_name,status) VALUES(${id}::uuid,${id + "@example.invalid"},'Fictional gate API','active')`;
            await sql`INSERT INTO memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${id}::uuid,${role})`;
          }
          await sql`SET LOCAL ROLE platform_web`;
          await sql`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${owner},true),set_config('app.current_role','owner',true)`;
          const profile = await createAgentProfileDraft(sql, owner, {
            name: "Fictional pending golden API",
            systemPrompt: "Ask for approved details.",
            locale: "en",
            channels: ["whatsapp"],
          });
          const version = required(
            (await listAgentQualityVersions(sql, profile))[0],
          ).id;
          expect(await getAgentGoldenWorkspace(sql, profile, version)).toEqual({
            enabled: false,
            datasets: [],
            evaluations: [],
          });
          await assertAgentGoldenPublishable(sql, version);
          await expect(
            getAgentGoldenWorkspace(sql, randomUUID(), version),
          ).rejects.toMatchObject({ code: "42501" });
          const cases = Array.from({ length: 30 }, (_, index) => ({
            id: randomUUID(),
            channel: "whatsapp",
            input: "Fictional scenario " + String(index),
            expected: { clarify: true },
          }));
          const datasets = await sql<{ id: string }[]>`
            SELECT platform.create_quality_dataset(${profile}::uuid,'synthetic_fixture',${sql.json(cases)},'{}'::jsonb) AS id
          `;
          const dataset = required(datasets[0]).id;
          await expect(
            sql.savepoint((nested) =>
              requestAgentGoldenEvaluation(nested, profile, {
                versionId: version,
                datasetId: dataset,
              }),
            ),
          ).rejects.toMatchObject({ code: "55000" });
          await sql`SELECT platform.set_agent_quality_gate(true)`;
          const job = await requestAgentGoldenEvaluation(sql, profile, {
            versionId: version,
            datasetId: dataset,
          });
          const workspace = await getAgentGoldenWorkspace(
            sql,
            profile,
            version,
          );
          expect(workspace.enabled).toBe(true);
          expect(workspace.datasets).toEqual([]);
          expect(workspace.evaluations).toMatchObject([
            { id: job, state: "blocked", hasAcceptedReceipt: false },
          ]);
          const originalBindings = await sql`
            SELECT whatsapp_ai_agent_profile_id FROM crm.tenant_settings
            WHERE tenant_id=platform.current_tenant_id()
          `;
          await expect(
            sql.savepoint((nested) =>
              assertAgentGoldenPublishable(nested, version),
            ),
          ).rejects.toMatchObject({ code: "AGENT_GOLDEN_EVIDENCE_REQUIRED" });
          await expect(
            sql.savepoint((nested) =>
              publishAgentProfile(nested, owner, profile),
            ),
          ).rejects.toMatchObject({ code: "AGENT_GOLDEN_EVIDENCE_REQUIRED" });
          expect(
            required((await listAgentQualityVersions(sql, profile))[0])
              .publishedAt,
          ).toBeNull();
          expect(
            await sql`
              SELECT whatsapp_ai_agent_profile_id FROM crm.tenant_settings
              WHERE tenant_id=platform.current_tenant_id()
            `,
          ).toEqual(originalBindings);
          await sql`SELECT platform.set_agent_quality_gate(false)`;
          expect(await publishAgentProfile(sql, owner, profile)).toBe(true);
          expect(
            required((await listAgentQualityVersions(sql, profile))[0])
              .publishedAt,
          ).not.toBeNull();
          await sql`SELECT set_config('app.current_user',${viewer},true),set_config('app.current_role','owner',true)`;
          await expect(
            sql.savepoint((nested) =>
              getAgentGoldenWorkspace(nested, profile, version),
            ),
          ).rejects.toMatchObject({ code: "42501" });
          throw new RollbackFixture();
        }),
      ).rejects.toBeInstanceOf(RollbackFixture);
    } finally {
      await db.end({ timeout: 2 });
    }
  });
});
