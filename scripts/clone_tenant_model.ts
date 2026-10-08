/** Local admin rehearsal. Secret values are read from the environment and never reported. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { modelCredentialKeys } from "../services/ts/messaging-worker/src/model-credentials.js";
import {
  inspectModelMigration,
  prepareModelMigration,
  type ModelMigrationPlan,
} from "../services/ts/messaging-worker/src/model-configuration-migration.js";

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: "string" },
      actor: { type: "string" },
      output: { type: "string" },
      "apply-local": { type: "boolean", default: false },
    },
  });
  if (
    !values.plan ||
    !values.actor ||
    !values.output ||
    existsSync(values.output)
  )
    throw new Error("Plan, actor and unused evidence path required");
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.pathname.startsWith("/oron_")
  )
    throw new Error("Isolated local oron_* database required");
  const plan = JSON.parse(
    readFileSync(values.plan, "utf8"),
  ) as ModelMigrationPlan;
  const db = postgres(url.toString(), { max: 1 });
  try {
    const result = await db.begin(async (tx) => {
      if (!values["apply-local"]) await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL ROLE platform_web`;
      await tx`SELECT set_config('app.current_tenant',${plan.tenantId},true),set_config('app.current_user',${values.actor ?? ""},true),set_config('app.current_role','owner',true)`;
      return values["apply-local"]
        ? prepareModelMigration(
            tx,
            values.actor ?? "",
            plan,
            modelCredentialKeys(process.env),
          )
        : inspectModelMigration(tx, plan);
    });
    writeFileSync(values.output, JSON.stringify(result, null, 2) + "\n", {
      flag: "wx",
    });
  } finally {
    await db.end();
  }
}
void main();
