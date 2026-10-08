import { afterEach, expect, it, vi } from "vitest";
import {
  OpenAiCompatibleChatProvider,
  providerReportedUsage,
} from "./ai-provider.js";

afterEach(() => vi.unstubAllGlobals());

it("retains provider token subsets without adding reasoning or audio to the totals", () => {
  expect(
    providerReportedUsage(
      {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 300, audio_tokens: 200 },
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      },
      12,
    ),
  ).toEqual({
    inputTokens: 1000,
    outputTokens: 100,
    latencyMs: 12,
    tokenDetails: {
      cachedInput: 300,
      audioInput: 200,
      cachedAudioInput: null,
      reasoningOutput: 40,
      audioOutput: null,
    },
  });
  expect(
    providerReportedUsage(
      {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: -1, audio_tokens: 99 },
          completion_tokens_details: { reasoning_tokens: 6 },
        },
      },
      0,
    )?.tokenDetails,
  ).toEqual({
    cachedInput: null,
    audioInput: null,
    cachedAudioInput: null,
    reasoningOutput: null,
    audioOutput: null,
  });
});

it("recomputes Gemini parameters on one bounded 429 fallback and records both attempts", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init: RequestInit) => {
      if (typeof init.body !== "string")
        throw new TypeError("Expected JSON body");
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      if (bodies.length === 1)
        return Promise.resolve(new Response("", { status: 429 }));
      return Promise.resolve(
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "reply",
                  text: "שלום",
                  reasonCode: null,
                  replyCode: null,
                }),
              },
            },
          ],
        }),
      );
    }),
  );
  const attempts: unknown[] = [];
  const provider = new OpenAiCompatibleChatProvider({
    apiKey: "fictional",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.5-flash-lite",
    fallbackModel: "gemini-3.1-flash-lite",
  });
  await expect(
    provider.decide(
      {
        systemPrompt: "Help with approved services.",
        locale: "he",
        messages: [{ role: "user", text: "שלום" }],
      },
      undefined,
      (a) => {
        attempts.push(a);
        return Promise.resolve();
      },
    ),
  ).resolves.toMatchObject({ action: "reply", text: "שלום" });
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({
    model: "gemini-3.5-flash-lite",
    reasoning_effort: "minimal",
  });
  expect(bodies[0]).not.toHaveProperty("temperature");
  expect(bodies[1]).toMatchObject({
    model: "gemini-3.1-flash-lite",
    reasoning_effort: "minimal",
    temperature: 0.2,
  });
  expect(attempts).toHaveLength(2);
});
