import { writeFile } from "node:fs/promises";
import { parseLeadFieldSchema } from "@or-on/crm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAiCompatibleChatProvider,
  type WhatsAppAiRequest,
} from "./ai-provider.js";
import { promptContextCodePoints } from "./prompt-context-budget.js";

afterEach(() => vi.unstubAllGlobals());
interface CapturedBody {
  messages: { role: string; content: string }[];
  response_format: unknown;
}
interface Context {
  knowledge: {
    sourceId: string;
    documentId: string;
    version: number;
    factKey: string;
    value: string;
  }[];
  messages: { role: string; text: string; truncated?: boolean }[];
  retrievedDocumentContext: unknown[];
  customerSessionMemory?: unknown;
  tenantBusinessProfile?: unknown;
  contactContext?: unknown;
  contextTruncation?: unknown;
  serviceIntake?: unknown;
  leadCollection?: unknown;
  actionReceipts?: unknown;
}
const fixture: WhatsAppAiRequest = {
  systemPrompt:
    "Use approved price and actual action receipts. Never invent a successful booking.",
  locale: "he",
  messages: Array.from({ length: 30 }, (_, index) => ({
    role: "user",
    text: `Fictional message ${String(index)} ${"פרטי שירות 😀 ".repeat(90)}`,
  })),
  knowledge: Array.from({ length: 20 }, (_, index) => ({
    sourceId: "00000000-0000-4000-8000-000000000001",
    documentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    version: 3,
    factKey: `price_${String(index)}`,
    value: `Service price ₪1234.56 incl VAT. ${"Synthetic business detail. ".repeat(20)}`,
  })),
  knowledgeChunks: Array.from({ length: 8 }, (_, index) => ({
    documentId: `synthetic-document-${String(index)}`,
    content: "Synthetic document context ".repeat(40),
  })),
  sessionMemory: "Synthetic customer memory ".repeat(350),
  lead: {
    schema: parseLeadFieldSchema([
      { key: "budget", label: "Budget", type: "currency", required: false },
    ]),
    missingRequired: [],
    status: "collecting",
    collected: [{ key: "budget", state: "provided", value: "1234.56" }],
  },
  serviceIntake: {
    status: "collecting",
    fields: { address: "Synthetic street", service: "maintenance" },
    missingFields: ["appointment"],
    nationalIdMasked: null,
    caseReference: "SYNTHETIC-123",
    customerResolutionStatus: "matched",
  },
  actionReceipts: [
    {
      action: "create_booking",
      ok: false,
      reference: null,
      detail: "Not committed: slot unavailable",
    },
  ],
};

async function capture(enabled: boolean) {
  let serialized = "";
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init: RequestInit) => {
      if (typeof init.body !== "string")
        throw new TypeError("Expected request JSON");
      serialized = init.body;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "reply",
                    text: "Please clarify.",
                    reasonCode: null,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }),
  );
  const provider = new OpenAiCompatibleChatProvider({
    apiKey: "synthetic-not-a-key",
    baseUrl: "https://provider.example.invalid/v1",
    model: "synthetic-model",
  });
  await provider.decide({ ...fixture, contextBudgetEnabled: enabled });
  const body = JSON.parse(serialized) as CapturedBody;
  const context = JSON.parse(
    body.messages.find((message) => message.role === "user")?.content ?? "{}",
  ) as Context;
  return { serialized, body, context };
}

describe("actual provider context budget serialization", () => {
  it("bounds the projected untrusted context and preserves trusted business state and actual failed receipt", async () => {
    const before = await capture(false),
      after = await capture(true);
    const projected = {
      knowledge: after.context.knowledge,
      messages: after.context.messages,
      retrievedDocumentContext: after.context.retrievedDocumentContext,
      ...(after.context.customerSessionMemory === undefined
        ? {}
        : { customerSessionMemory: after.context.customerSessionMemory }),
      ...(after.context.tenantBusinessProfile === undefined
        ? {}
        : { tenantBusinessProfile: after.context.tenantBusinessProfile }),
      ...(after.context.contactContext === undefined
        ? {}
        : { contactContext: after.context.contactContext }),
      contextTruncation: after.context.contextTruncation,
    };
    expect(promptContextCodePoints(projected)).toBeLessThanOrEqual(4000);
    expect(after.context.actionReceipts).toEqual(before.context.actionReceipts);
    expect(after.context.actionReceipts).toEqual(fixture.actionReceipts);
    expect(after.context.leadCollection).toEqual(before.context.leadCollection);
    expect(after.context.serviceIntake).toEqual(before.context.serviceIntake);
    expect(
      after.body.messages.find((message) => message.role === "system"),
    ).toEqual(
      before.body.messages.find((message) => message.role === "system"),
    );
    expect(after.body.response_format).toEqual(before.body.response_format);
    expect(after.context.knowledge.length).toBeGreaterThan(0);
    for (const fact of after.context.knowledge)
      expect(fact).toEqual(
        fixture.knowledge?.find(
          (original) => original.factKey === fact.factKey,
        ),
      );
    const latest = after.context.messages.at(-1);
    const original = fixture.messages.at(-1)?.text ?? "";
    expect(original.startsWith(latest?.text ?? "missing")).toBe(true);
    if (latest?.text !== original) expect(latest?.truncated).toBe(true);
    const measurements = (
      captureResult: Awaited<ReturnType<typeof capture>>,
    ) => ({
      fullBodyBytes: Buffer.byteLength(captureResult.serialized),
      userContextBytes: Buffer.byteLength(
        captureResult.body.messages.find((message) => message.role === "user")
          ?.content ?? "",
      ),
      systemBytes: Buffer.byteLength(
        captureResult.body.messages.find((message) => message.role === "system")
          ?.content ?? "",
      ),
      schemaBytes: Buffer.byteLength(
        JSON.stringify(captureResult.body.response_format),
      ),
    });
    await writeFile(
      new URL(
        "../../../../../evidence/prompt-provider-size-local.json",
        import.meta.url,
      ),
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          node: process.version,
          synthetic: true,
          before: measurements(before),
          after: measurements(after),
          projectedUntrustedCodePoints: promptContextCodePoints(projected),
          retainedFacts: after.context.knowledge.length,
          trustedStateAndSchemaUnchanged: true,
          limitations: [
            "One identical synthetic provider-request fixture, intercepted fetch; no actual provider traffic.",
            "Different retained context; no semantic-parity, tokens, cost or LLM-latency claim.",
            "4000codepoint cap applies projected untrusted JSON, not full request or verified state/system/schema.",
          ],
        },
        null,
        2,
      ),
    );
  });
});
