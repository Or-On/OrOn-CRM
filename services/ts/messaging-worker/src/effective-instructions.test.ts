import { afterEach, expect, it, vi } from "vitest";
import { composeWhatsAppInstructions } from "@or-on/crm";
import {
  OpenAiCompatibleChatProvider,
  type WhatsAppAiAttempt,
} from "./ai-provider.js";
afterEach(() => vi.unstubAllGlobals());
it("sends the inspector's exact instruction bytes and records fallback attempt hashes", async () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const attempts: WhatsAppAiAttempt[] = [];
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    await Promise.resolve();
    bodies.push(
      JSON.parse(init.body as string) as {
        messages: { role: string; content: string }[];
      },
    );
    return bodies.length === 1
      ? new Response("", { status: 503 })
      : new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "reply",
                    text: "שלום",
                    replyCode: null,
                    reasonCode: null,
                    documentId: null,
                    factKey: null,
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
  });
  vi.stubGlobal("fetch", fetcher);
  const provider = new OpenAiCompatibleChatProvider({
    apiKey: "fictional",
    baseUrl: "https://api.openai.test/v1",
    model: "test-model",
    fallbackModel: "fallback-model",
  });
  await provider.decide(
    { systemPrompt: "Help", locale: "he", messages: [] },
    undefined,
    async (attempt) => {
      attempts.push(attempt);
      await Promise.resolve();
    },
  );
  const inspected = composeWhatsAppInstructions({
    systemPrompt: "Help",
    locale: "he",
    capabilities: [],
    actionNames: ["reply", "knowledge", "handoff", "request_call"],
    surfaces: {},
  });
  expect(bodies).toHaveLength(2);
  expect(attempts).toHaveLength(2);
  for (const body of bodies)
    expect(body.messages[0]?.content).toBe(inspected.text);
  for (const attempt of attempts) {
    expect(attempt.runtimeInstructionHash).toBe(inspected.hash);
    expect(attempt.compositionVersion).toBe(inspected.compositionVersion);
  }
});
