import { afterEach, expect, it, vi } from "vitest";
import { OpenAiCompatibleChatProvider } from "./ai-provider.js";

afterEach(() => vi.unstubAllGlobals());
it("rechecks authorization before immediate fallback and prevents its paid HTTP when revoked", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "invalid model decision" } }],
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const guard = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("ownership_revoked"));
  const provider = new OpenAiCompatibleChatProvider({
    apiKey: "synthetic-key",
    baseUrl: "https://example.invalid/v1",
    model: "synthetic-model",
  });
  const recordedAttemptIds: string[] = [];
  await expect(
    provider.decide(
      {
        systemPrompt: "Use approved information",
        locale: "he",
        messages: [{ role: "user", text: "שלום" }],
      },
      undefined,
      (attempt) => {
        recordedAttemptIds.push(attempt.eventId);
        return Promise.resolve();
      },
      guard,
    ),
  ).rejects.toThrow("ownership_revoked");
  expect(guard).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(recordedAttemptIds).toHaveLength(1);
});
