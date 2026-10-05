import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  createAgentProfileDraft,
  listAgentProfiles,
  publishAgentProfile,
} from "./cross-channel.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;

interface Draft {
  readonly agent: {
    readonly name: string;
    readonly description: string;
    readonly locale: string;
    readonly channels: readonly ("voice" | "whatsapp")[];
    readonly toolPermissions: readonly "service.intake"[];
    readonly systemPrompt: string;
  };
}

class ExpectedRollback extends Error {}

describe.skipIf(databaseUrl === undefined)(
  "ProTouch agent draft is tenant-scoped and publishable",
  () => {
    it("publishes the reviewed service agent without touching another tenant", async () => {
      if (databaseUrl === undefined) throw new Error("fixture URL required");
      const target = new URL(databaseUrl);
      if (
        !["localhost", "127.0.0.1"].includes(target.hostname) ||
        !/^\/oron_ui_preview_[0-9a-f]{32}$/u.test(target.pathname)
      )
        throw new Error("owned local database required");
      const manifest = JSON.parse(
        readFileSync(
          resolve(
            process.cwd(),
            "../../../infra/tenant-configurations/protouch.agent.json",
          ),
          "utf8",
        ),
      ) as Draft;
      const database = postgres(databaseUrl, { max: 1, prepare: false });
      const tenant = randomUUID();
      const otherTenant = randomUUID();
      const actor = randomUUID();
      try {
        await expect(
          database.begin(async (sql) => {
            await sql`INSERT INTO tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional ProTouch',${`protouch-fixture-${tenant}`},'active'),(${otherTenant}::uuid,'Fictional other tenant',${`other-fixture-${otherTenant}`},'active')`;
            await sql`INSERT INTO users(id,email,display_name,status) VALUES(${actor}::uuid,${`${actor}@example.invalid`},'Fictional operator','active')`;
            await sql`INSERT INTO memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${actor}::uuid,'owner')`;
            await sql`INSERT INTO crm.tenant_settings(tenant_id) VALUES(${tenant}::uuid),(${otherTenant}::uuid)`;
            await sql`INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,granted_at,source) VALUES(${tenant}::uuid,'field_service',true,true,CURRENT_TIMESTAMP,'provisioning')`;
            await sql`INSERT INTO service.tenant_configuration(tenant_id,enabled) VALUES(${tenant}::uuid,true)`;
            await sql`SET LOCAL ROLE platform_web`;
            await sql`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${actor},true),set_config('app.current_role','owner',true)`;
            const id = await createAgentProfileDraft(
              sql,
              actor,
              manifest.agent,
            );
            expect(await publishAgentProfile(sql, actor, id)).toBe(true);
            const versions = await sql<
              {
                system_prompt: string;
                locale: string;
                tool_permissions: string[];
                published_at: Date | null;
              }[]
            >`SELECT system_prompt,locale,tool_permissions,published_at
              FROM agents.agent_profile_versions WHERE agent_profile_id=${id}::uuid`;
            expect(versions).toHaveLength(1);
            expect(versions[0]?.system_prompt).toBe(
              manifest.agent.systemPrompt,
            );
            expect(versions[0]?.locale).toBe("he");
            expect(versions[0]?.tool_permissions).toEqual(["service.intake"]);
            expect(versions[0]?.published_at).toBeInstanceOf(Date);
            expect(await listAgentProfiles(sql)).toEqual([
              expect.objectContaining({
                id,
                name: manifest.agent.name,
                published: true,
                channels: ["voice", "whatsapp"],
              }),
            ]);
            await sql`SELECT set_config('app.current_tenant',${otherTenant},true)`;
            expect(await listAgentProfiles(sql)).toEqual([]);
            throw new ExpectedRollback();
          }),
        ).rejects.toThrow(ExpectedRollback);
      } finally {
        await database.end({ timeout: 2 });
      }
    });
  },
);
