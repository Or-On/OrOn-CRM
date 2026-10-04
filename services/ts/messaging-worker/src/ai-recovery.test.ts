import { afterEach, expect, it, vi } from "vitest";
import type { WhatsAppAiAttempt, WhatsAppAiUsage } from "./ai-provider.js";
import { OpenAiCompatibleChatProvider } from "./ai-provider.js";

afterEach(() => vi.unstubAllGlobals());
it("rechecks authorization before fallback and does not bill a denied attempt", async () => {
  const execute = vi.fn().mockResolvedValue(response({}, "length"));
  vi.stubGlobal("fetch", execute);
  const attempts = vi.fn().mockResolvedValue(undefined);
  const guard = vi
    .fn<() => Promise<void>>()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new TypeError("AI conversation ownership changed"));
  await expect(
    provider().decide(request, undefined, attempts, guard),
  ).rejects.toThrow("AI conversation ownership changed");
  expect(guard).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledOnce();
  expect(attempts).toHaveBeenCalledOnce();
});
it("records distinct primary/fallback attempt IDs and shared usage IDs", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(response({}, "length"))
      .mockResolvedValueOnce(
        response({ action: "reply", text: "Hello", reasonCode: null }),
      ),
  );
  const usages = vi
    .fn<(usage: WhatsAppAiUsage) => Promise<void>>()
    .mockResolvedValue(undefined);
  const attempts = vi
    .fn<(attempt: WhatsAppAiAttempt) => Promise<void>>()
    .mockResolvedValue(undefined);
  await provider("alternate").decide(request, usages, attempts);
  expect(attempts).toHaveBeenCalledTimes(2);
  const first = required(attempts.mock.calls[0])[0];
  const second = required(attempts.mock.calls[1])[0];
  expect(first.eventId).not.toBe(second.eventId);
  expect(first).toMatchObject({
    model: "verified-primary",
    status: "invalid_response",
    errorCode: "ai_output_truncated",
  });
  expect(second).toMatchObject({ model: "alternate", status: "succeeded" });
  expect(required(usages.mock.calls[0])[0].eventId).toBe(first.eventId);
});
it("keeps unknown counts null and retains failed attempt recording without losing answer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "reply",
                  text: "Hello",
                  reasonCode: null,
                }),
              },
            },
          ],
        }),
      ),
    ),
  );
  const client = provider();
  expect(
    await client.decide(request, undefined, () =>
      Promise.reject(new Error("ledger unavailable")),
    ),
  ).toMatchObject({ action: "reply" });
  const pending = client.pendingAttempts();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    status: "succeeded",
    errorCode: null,
  });
  client.acknowledgeAttempt(required(pending[0]));
  expect(client.pendingAttempts()).toEqual([]);
});
it("records both timed-out HTTP attempts with unknown counts", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ),
  );
  const client = new OpenAiCompatibleChatProvider({
    apiKey: "fictional",
    baseUrl: "https://example.test",
    model: "verified-primary",
    timeoutMs: 1,
  });
  const attempts = vi
    .fn<(attempt: WhatsAppAiAttempt) => Promise<void>>()
    .mockResolvedValue(undefined);
  await expect(
    client.decide(request, undefined, attempts),
  ).rejects.toMatchObject({ code: "ai_timeout", retryable: false });
  expect(attempts).toHaveBeenCalledTimes(2);
  expect(required(attempts.mock.calls[0])[0]).toMatchObject({
    status: "timeout",
    inputTokens: null,
    outputTokens: null,
  });
});
const request = {
  systemPrompt: "Help",
  locale: "en",
  messages: [{ role: "user" as const, text: "Hi" }],
};
function response(decision: unknown, finish = "stop") {
  return new Response(
    JSON.stringify({
      usage: { prompt_tokens: 3, completion_tokens: 4 },
      choices: [
        {
          finish_reason: finish,
          message: { content: JSON.stringify(decision) },
        },
      ],
    }),
  );
}
function provider(fallbackModel?: string) {
  return new OpenAiCompatibleChatProvider({
    apiKey: "fictional",
    baseUrl: "https://example.test",
    model: "verified-primary",
    ...(fallbackModel ? { fallbackModel } : {}),
  });
}
it("immediately retries truncation once with configured fallback and 800 tokens", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(response({}, "length"))
    .mockResolvedValueOnce(
      response({ action: "reply", text: "Hello", reasonCode: null }),
    );
  vi.stubGlobal("fetch", fetch);
  expect(await provider("verified-fallback").decide(request)).toMatchObject({
    action: "reply",
    text: "Hello",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  const body = requestBody(required(fetch.mock.calls[1])[1]);
  expect(body).toMatchObject({ model: "verified-fallback", max_tokens: 800 });
});
it("uses verified primary for one bounded recovery when no alternate is configured", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() => Promise.resolve(response({}, "length")));
  vi.stubGlobal("fetch", fetch);
  await expect(provider().decide(request)).rejects.toMatchObject({
    code: "ai_output_truncated",
    retryable: false,
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(requestBody(required(fetch.mock.calls[1])[1])).toMatchObject({
    model: "verified-primary",
    max_tokens: 800,
  });
});
it("ignores irrelevant envelope fields while preserving allowed action checks", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() =>
      Promise.resolve(
        response({
          action: "reply",
          text: "Hello",
          reasonCode: null,
          irrelevant: "ignored",
        }),
      ),
    ),
  );
  expect(await provider().decide(request)).toMatchObject({
    action: "reply",
    text: "Hello",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() =>
      Promise.resolve(
        response({
          action: "lead_save",
          leadObservations: [],
          irrelevant: "ignored",
        }),
      ),
    ),
  );
  await expect(provider().decide(request)).rejects.toMatchObject({
    code: "ai_invalid_output",
    retryable: false,
  });
});
it("retains failed accounting without retrying or discarding a valid answer", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      response({ action: "reply", text: "Hello", reasonCode: null }),
    );
  vi.stubGlobal("fetch", fetch);
  const client = provider();
  expect(
    await client.decide(request, () =>
      Promise.reject(new Error("fictional DB outage")),
    ),
  ).toMatchObject({ action: "reply" });
  expect(fetch).toHaveBeenCalledTimes(1);
  const pending = client.pendingUsage();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ inputTokens: 3, outputTokens: 4 });
  client.acknowledgeUsage(required(pending[0]));
  expect(client.pendingUsage()).toEqual([]);
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}
function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string")
    throw new Error("Expected JSON request body");
  return JSON.parse(init.body) as unknown;
}
