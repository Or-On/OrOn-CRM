import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAiCompatibleChatProvider,
  providerReportedUsage,
} from "../src/ai-provider.js";

describe("provider-reported usage", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("accounts billed invalid model output before rejecting the decision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 11, completion_tokens: 5 },
          }),
          { status: 200 },
        ),
      ),
    );
    const usage = vi.fn().mockResolvedValue(undefined);
    const provider = new OpenAiCompatibleChatProvider({
      baseUrl: "https://fictional.invalid/v1",
      apiKey: "fictional-only",
      model: "fictional-model",
    });
    await expect(
      provider.decide(
        { systemPrompt: "Fictional test", locale: "he", messages: [] },
        usage,
      ),
    ).rejects.toMatchObject({ code: "ai_invalid_output" });
    expect(usage).toHaveBeenCalledOnce();
    expect(usage.mock.calls[0]?.[0]).toMatchObject({
      inputTokens: 11,
      outputTokens: 5,
    });
  });
  it("preserves exact provider counts, including explicit zero", () => {
    expect(
      providerReportedUsage(
        { usage: { prompt_tokens: 23, completion_tokens: 0 } },
        123.7,
      ),
    ).toEqual({
      inputTokens: 23,
      outputTokens: 0,
      latencyMs: 124,
      tokenDetails: {
        cachedInput: null,
        audioInput: null,
        cachedAudioInput: null,
        reasoningOutput: null,
        audioOutput: null,
      },
    });
  });
  it("never invents absent counts or accepts malformed billing data", () => {
    for (const payload of [
      null,
      {},
      { usage: {} },
      { usage: { prompt_tokens: 2 } },
      { usage: { prompt_tokens: -1, completion_tokens: 2 } },
      { usage: { prompt_tokens: "2", completion_tokens: 2 } },
      { usage: { prompt_tokens: 1.5, completion_tokens: 2 } },
      {
        usage: {
          prompt_tokens: Number.MAX_SAFE_INTEGER + 1,
          completion_tokens: 2,
        },
      },
    ]) {
      expect(providerReportedUsage(payload, 1)).toBeUndefined();
    }
  });
});
