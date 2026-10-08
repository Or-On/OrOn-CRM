/** Paid, synthetic semantic evaluation. No messaging transport or customer database. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  parseLeadFieldSchema,
  normalizeLeadField,
} from "../packages/ts/crm/src/lead-schema.js";
import { parseAgentCapabilities } from "../packages/ts/crm/src/agent-capabilities.js";
import {
  classifyCustomerTurn,
  approvedAgentResponse,
  repeatedScopeRedirect,
} from "../packages/ts/crm/src/agent-scope-policy.js";
import {
  composeAgentInstructions,
  renderAgentInstructions,
} from "../packages/ts/crm/src/agent-prompt.js";
import {
  OpenAiCompatibleChatProvider,
  type WhatsAppAiRequest,
  type WhatsAppActionReceipt,
  type WhatsAppAiAttempt,
} from "../services/ts/messaging-worker/src/ai-provider.js";
import {
  groundAiReply,
  guardFailedLeadReply,
} from "../services/ts/messaging-worker/src/ai-grounding.js";

interface Scenario {
  id: string;
  turns: string[];
  mustMention?: string;
  forbidFinal?: boolean;
  forbidFields?: boolean;
  forbidContactQuestion?: boolean;
  forbidPrice?: boolean;
  expectName?: string;
  expectPhone?: string;
  forbidPhone?: boolean;
  verifiedPhone?: string;
  requireFinal?: boolean;
  failSave?: boolean;
  completed?: boolean;
  otherTenant?: boolean;
  forbidOrOn?: boolean;
}
const readJson = async (path: string) =>
  JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
async function main() {
  const sourceHashes = Object.fromEntries<string>(
    await Promise.all(
      [
        "infra/tenant-configurations/oron.whatsapp-lead.agent.json",
        "infra/tenant-configurations/oron.service-catalog.json",
        "db/contracts/service-discovery-scenarios.v1.json",
        "db/contracts/service-agent-policy.v1.json",
        "db/contracts/agent-runtime-policy.v1.json",
        "packages/ts/crm/src/agent-prompt.ts",
        "services/ts/messaging-worker/src/ai-provider.ts",
        "services/ts/messaging-worker/src/ai-grounding.ts",
      ].map(async (path): Promise<[string, string]> => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
  const environment = {
    node: process.version,
    platform: process.platform,
    startedAt: new Date().toISOString(),
    sourceHashes,
  };
  const manifest = (await readJson(
    "infra/tenant-configurations/oron.whatsapp-lead.agent.json",
  )) as {
    systemPrompt: string;
    fields: unknown;
    capabilities: string[];
  };
  const catalog = (await readJson(
    "infra/tenant-configurations/oron.service-catalog.json",
  )) as {
    businessDescription: string;
    productsAndServices: string[];
  };
  const corpus = (await readJson(
    "db/contracts/service-discovery-scenarios.v1.json",
  )) as { scenarios: Scenario[] };
  const output = resolve(
    process.env.SERVICE_DISCOVERY_EVAL_OUTPUT ??
      ".artifacts/service-discovery-eval",
  );
  await mkdir(output, { recursive: true });
  const capabilities = parseAgentCapabilities(manifest.capabilities);
  const schema = parseLeadFieldSchema(manifest.fields);
  // Voice uses precisely the same composition; its delivery/identity layer is added in Python.
  await writeFile(
    resolve(output, "voice-instructions.json"),
    JSON.stringify(
      {
        environment,
        prompt: renderAgentInstructions(
          composeAgentInstructions({
            agentPrompt: manifest.systemPrompt,
            channel: "voice",
            locale: "he",
            capabilities,
            surfaces: { leadCollection: true },
          }),
        ),
        fields: manifest.fields,
        catalog,
      },
      null,
      2,
    ),
  );
  if (process.argv.includes("--export-only")) process.exit(0);
  if (
    !process.argv.includes("--allow-provider-evals") ||
    process.env.ORON_RUN_PROVIDER_EVALS !== "true"
  )
    throw new Error("Explicit provider evaluation opt-in is required");
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error("Explicit evaluation credential is required");

  const results: Record<string, unknown>[] = [];
  for (const model of ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]) {
    for (const scenario of corpus.scenarios) {
      const attempts: WhatsAppAiAttempt[] = [];
      const messages: { role: "user" | "assistant"; text: string }[] = [];
      const fields = new Map<
        string,
        { key: string; state: string; value: string | null }
      >();
      const replies: string[] = [];
      const actions: string[] = [];
      const decisions: unknown[] = [];
      let finals = 0;
      let status = scenario.completed ? "ready_for_review" : "new";
      const failures: string[] = [];
      const provider = new OpenAiCompatibleChatProvider({
        apiKey,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        model,
        timeoutMs: 45000,
        maxTokens: 2048,
      });
      try {
        for (const turn of scenario.turns) {
          messages.push({ role: "user", text: turn });
          const route = classifyCustomerTurn(turn).route;
          if (route !== null) {
            const reply = approvedAgentResponse(
              repeatedScopeRedirect(
                messages
                  .filter((m) => m.role === "user")
                  .slice(-32)
                  .map((m) => m.text),
              )
                ? "pause"
                : route,
              "he",
              scenario.otherTenant ? "סטודיו צבע" : "OrOn",
            );
            replies.push(reply);
            messages.push({ role: "assistant", text: reply });
            continue;
          }
          const receipts: WhatsAppActionReceipt[] = [];
          for (let round = 0; round < 5; round++) {
            const request: WhatsAppAiRequest = {
              systemPrompt: manifest.systemPrompt,
              locale: "he",
              capabilities,
              tenantDisplayName: scenario.otherTenant ? "סטודיו צבע" : "OrOn",
              businessProfile: scenario.otherTenant
                ? {
                    businessDescription: "סטודיו לאמנות",
                    productsAndServices: ["שיעורי ציור", "סדנאות קרמיקה"],
                  }
                : catalog,
              lead: {
                schema,
                status,
                collected: [...fields.values()],
                missingRequired: schema.fields
                  .filter((f) => !fields.has(f.key))
                  .map((f) => f.key),
              },
              actionReceipts: receipts,
              replyOnly: round === 4,
              messages,
              ...(scenario.verifiedPhone
                ? {
                    contactContext: {
                      contact: {
                        name: "WhatsApp display label",
                        email: null,
                        company: null,
                        lifecycleStatus: "active",
                      },
                      identity: {
                        matchedBy: "verified_whatsapp_identity",
                        knownBeforeConversation: false,
                        firstConversation: true,
                        missingProfileFields: ["name"],
                        channelPhone: scenario.verifiedPhone,
                      },
                      notes: [],
                      previousConversations: [],
                      tickets: [],
                      voiceSessions: [],
                    },
                  }
                : {}),
            };
            const decision = await provider.decide(
              request,
              undefined,
              (attempt) => {
                attempts.push(attempt);
                return Promise.resolve();
              },
            );
            actions.push(decision.action);
            decisions.push(decision);
            if (
              decision.action === "reply" ||
              decision.action === "knowledge" ||
              decision.action === "handoff" ||
              decision.action === "request_call"
            ) {
              const finalDecision = guardFailedLeadReply(
                decision,
                receipts,
                "he",
              );
              const delivered = groundAiReply(
                finalDecision,
                [],
                "he",
                replies,
                turn,
                receipts.some((receipt) => receipt.ok)
                  ? {
                      leadId: "synthetic",
                      revision: 1,
                      operation:
                        status === "ready_for_review"
                          ? "lead.finalize"
                          : "lead.save",
                    }
                  : undefined,
              ).text;
              replies.push(delivered);
              messages.push({ role: "assistant", text: delivered });
              break;
            }
            if (decision.action === "lead_save") {
              if (scenario.failSave) {
                receipts.push({
                  action: "lead_save",
                  ok: false,
                  reference: null,
                  detail:
                    "Storage unavailable; no data committed. Do not claim success.",
                });
              } else {
                for (const observation of decision.observations) {
                  const value = normalizeLeadField(schema, observation, {
                    phoneRegion: "IL",
                  });
                  fields.set(value.key, {
                    key: value.key,
                    state: value.state,
                    value: value.normalizedValue,
                  });
                }
                status = "collecting";
                receipts.push({
                  action: "lead_save",
                  ok: true,
                  reference: "LD-SYNTHETIC",
                  detail:
                    "Fields committed in semantic fixture; not finalized.",
                });
              }
            } else if (decision.action === "lead_finalize") {
              const ready =
                schema.fields.every(
                  (f) => fields.get(f.key)?.state === "known",
                ) &&
                fields.get("follow_up_allowed")?.value === "true" &&
                fields.get("discussion_complete")?.value === "true";
              if (
                ready &&
                status !== "ready_for_review" &&
                !scenario.failSave
              ) {
                finals++;
                status = "ready_for_review";
                receipts.push({
                  action: "lead_finalize",
                  ok: true,
                  reference: "LD-SYNTHETIC",
                  detail:
                    "Committed: status ready_for_review, staff review item exists in semantic fixture.",
                });
              } else
                receipts.push({
                  action: "lead_finalize",
                  ok: false,
                  reference: null,
                  detail:
                    "Required readiness missing or enquiry already finalized. No new lead.",
                });
            } else
              receipts.push({
                action: decision.action,
                ok: false,
                reference: null,
                detail: "No such authorized action in this fixture.",
              });
          }
        }
        const text = replies.join("\n");
        if (
          scenario.mustMention &&
          !new RegExp(scenario.mustMention, "iu").test(text)
        )
          failures.push("required relevant answer absent");
        if (scenario.forbidFinal && finals)
          failures.push("premature finalization");
        if (scenario.requireFinal && finals !== 1)
          failures.push("missing finalization");
        if (finals > 1) failures.push("duplicate finalization");
        if (scenario.forbidFields && fields.size)
          failures.push("unjustified field collection");
        if (
          scenario.forbidContactQuestion &&
          /(?:מה|איך)[^\n?]{0,15}(?:שמ[ךכ]|קוראים)|(?:מה|איזה|באיזה)[^\n?]{0,20}(?:טלפון|מספר).*\?/u.test(
            text,
          )
        )
          failures.push("premature/repeated contact question");
        if (scenario.forbidPrice && /[0-9]+\s*(?:₪|שקלים|ש״ח|דולר)/u.test(text))
          failures.push("invented price");
        if (
          scenario.expectName &&
          fields.get("contact_name")?.value !== scenario.expectName
        )
          failures.push("name not stored/corrected");
        if (
          scenario.expectPhone &&
          fields.get("contact_phone")?.value !== scenario.expectPhone
        )
          failures.push("phone not stored/normalized");
        if (
          scenario.forbidPhone &&
          fields.get("contact_phone")?.value !== null &&
          fields.get("contact_phone")?.value !== undefined
        )
          failures.push("partial phone stored");
        if (scenario.forbidOrOn && /Or.?On|אור.?און/iu.test(text))
          failures.push("cross tenant identity");
        if (scenario.failSave && /נפתח ליד|הפרטים נשמרו/u.test(text))
          failures.push("false save claim");
      } catch (error) {
        failures.push(
          error instanceof Error
            ? error.message.replaceAll(apiKey, "[REDACTED]")
            : "evaluation failed",
        );
      }
      results.push({
        model,
        id: scenario.id,
        failures,
        replies,
        actions,
        decisions,
        fields: [...fields.values()],
        finals,
        attempts,
      });
      await writeFile(
        resolve(output, "whatsapp.json"),
        JSON.stringify(
          {
            kind: "Real provider and production WhatsApp decision adapter; synthetic in-memory persistence, not transport/database acceptance",
            environment,
            promptSha256: createHash("sha256")
              .update(manifest.systemPrompt)
              .digest("hex"),
            results,
          },
          null,
          2,
        ),
      );
      console.log(
        `${model} ${scenario.id}: ${failures.length ? failures.join("; ") : "PASS"}`,
      );
    }
  }
  process.exitCode = results.some((r) => (r.failures as string[]).length > 0)
    ? 1
    : 0;
}
void main();
