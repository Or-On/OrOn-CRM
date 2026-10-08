import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createAgentProfileDraft } from "./cross-channel.js";
import { loadEffectivePromptContext } from "./effective-prompt.js";
const databaseUrl = process.env.CRM_TEST_DATABASE_URL;
class Rollback extends Error {}
describe.skipIf(!databaseUrl)(
  "effective prompt tenant-scoped PostgreSQL preview",
  () => {
    it("loads the exact draft under platform_web and cannot load another tenant's version", async () => {
      const url = new URL(databaseUrl ?? "");
      if (
        !["localhost", "127.0.0.1"].includes(url.hostname) ||
        !url.pathname.startsWith("/oron_")
      )
        throw new Error("owned local fixture required");
      const db = postgres(url.toString(), { max: 1 });
      try {
        await db
          .begin(async (sql) => {
            const tenant = randomUUID(),
              other = randomUUID(),
              actor = randomUUID();
            for (const id of [tenant, other])
              await sql`INSERT INTO public.tenants(id,name,slug,status) VALUES(${id}::uuid,'Fictional preview',${`preview-${id}`},'active')`;
            await sql`INSERT INTO public.users(id,email,display_name,status) VALUES(${actor}::uuid,${`preview-${actor}@example.invalid`},'Fictional owner','active')`;
            await sql`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${actor}::uuid,'owner')`;
            await sql`INSERT INTO crm.tenant_settings(tenant_id,support_profile) VALUES(${tenant}::uuid,${sql.json({ businessDescription: "Fictional catalog" })})`;
            await sql`SET LOCAL ROLE platform_web`;
            await sql`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${actor},true),set_config('app.current_role','owner',true)`;
            const profile = await createAgentProfileDraft(sql, actor, {
              name: "Fictional inspector",
              systemPrompt: "Explain fictional services.",
              channels: ["whatsapp", "voice"],
            });
            const [version] = await sql<
              { id: string }[]
            >`SELECT id FROM agents.agent_profile_versions WHERE agent_profile_id=${profile}::uuid`;
            expect(version).toBeDefined();
            if (!version) throw new Error("missing fixture version");
            const input = {
              profileId: profile,
              versionId: version.id,
              channel: "whatsapp" as const,
            };
            const preview = await loadEffectivePromptContext(sql, input);
            expect(preview?.context.state).toBe("draft");
            expect(preview?.preview.text).toContain(
              "Explain fictional services.",
            );
            expect(preview?.preview.blocks.at(-1)?.id).toBe("channel.envelope");
            expect(
              await loadEffectivePromptContext(sql, {
                ...input,
                profileId: randomUUID(),
              }),
            ).toBeNull();
            await sql`SELECT set_config('app.current_tenant',${other},true)`;
            expect(await loadEffectivePromptContext(sql, input)).toBeNull();
            throw new Rollback();
          })
          .catch((error: unknown) => {
            if (!(error instanceof Rollback)) throw error;
          });
      } finally {
        await db.end();
      }
    });
  },
);
