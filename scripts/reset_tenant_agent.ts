/** Local rehearsal only. Production activation requires separate reviewed authorization. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import postgres from "postgres";
import {
  inspectAgentReset,
  prepareAgentReset,
  publishPreparedAgentReset,
  activatePreparedAgentReset,
  rollbackPreparedAgentReset,
  type AgentResetPlan,
} from "../packages/ts/crm/src/agent-reset.js";

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: "string" },
      actor: { type: "string" },
      output: { type: "string" },
      phase: { type: "string", default: "inspect" },
      "apply-local": { type: "boolean", default: false },
      "agent-version": { type: "string" },
      "flow-definition": { type: "string" },
      "flow-version": { type: "string" },
      "rebind-existing-ai": { type: "boolean", default: false },
      "expected-active-release": { type: "string" },
      "rollback-operation": { type: "string" },
    },
  });
  if (!values.plan || !values.actor || !values.output)
    throw new Error("--plan, --actor and --output required");
  if (existsSync(values.output))
    throw new Error("Choose a new evidence output path before applying");
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.pathname.startsWith("/oron_")
  )
    throw new Error(
      "This rehearsal command requires an isolated local oron_* database",
    );
  const plan = JSON.parse(readFileSync(values.plan, "utf8")) as AgentResetPlan;
  const db = postgres(url.toString(), { max: 1 });
  try {
    const result = await db.begin(async (tx) => {
      if (values.phase === "inspect") await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL ROLE platform_web`;
      await tx`SELECT set_config('app.current_tenant',${plan.tenantId},true),set_config('app.current_user',${values.actor ?? ""},true),set_config('app.current_role','owner',true)`;
      if (values.phase === "inspect") {
        return inspectAgentReset(tx, plan);
      }
      if (!values["apply-local"])
        throw new Error("Mutations require explicit --apply-local");
      if (values.phase === "prepare")
        return prepareAgentReset(tx, values.actor ?? "", plan);
      if (values.phase === "rollback") {
        if (!values["expected-active-release"] || !values["rollback-operation"])
          throw new Error(
            "--expected-active-release and --rollback-operation required",
          );
        return rollbackPreparedAgentReset(
          tx,
          values.actor ?? "",
          plan,
          values["expected-active-release"],
          values["rollback-operation"],
        );
      }
      const version = values["agent-version"];
      if (!version) throw new Error("--agent-version required");
      if (values.phase === "publish") {
        if (!values["flow-definition"])
          throw new Error("--flow-definition required");
        await publishPreparedAgentReset(
          tx,
          values.actor ?? "",
          plan.profileId,
          version,
          values["flow-definition"],
        );
        return { published: true, activated: false };
      }
      if (values.phase === "activate") {
        if (!values["flow-version"]) throw new Error("--flow-version required");
        return activatePreparedAgentReset(
          tx,
          values.actor ?? "",
          plan,
          version,
          values["flow-version"],
          values["rebind-existing-ai"],
        );
      }
      throw new Error("Unknown phase");
    });
    writeFileSync(values.output, JSON.stringify(result, null, 2) + "\n", {
      flag: "wx",
    });
    console.log(
      "Local reset evidence written; no production activation performed.",
    );
  } finally {
    await db.end();
  }
}
void main();
