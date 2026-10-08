import { afterEach, expect, it, vi } from "vitest";
import { OpenAiCompatibleChatProvider } from "../src/ai-provider.js";
import { resolveTrustedModelRoute } from "../src/trusted-model-routing.js";

afterEach(() => vi.unstubAllGlobals());
it.each([false, true])(
  "honors trusted settings and reserves fallback spending (invalid first response: %s)",
  async (invalid) => {
    const tenantId = "00000000-0000-0000-0000-000000000001",
      agentVersionId = "00000000-0000-0000-0000-000000000002",
      actorUserId = "00000000-0000-0000-0000-000000000003",
      id = "00000000-0000-0000-0000-000000000004";
    let reservations = 0;
    const route = await resolveTrustedModelRoute(
      { tenantId, agentVersionId, actorUserId, channel: "whatsapp" },
      {
        readPublishedBinding: () =>
          Promise.resolve({
            tenantId,
            agentVersionId,
            published: true,
            validationStatus: "valid",
            authorized: true,
            modelConfigurationId: id,
          }),
        readConfiguration: () =>
          Promise.resolve({
            id,
            tenantId,
            provider: "gemini",
            model: "gemini-3.1-flash-lite",
            credentialId: id,
            enabled: true,
            settings: { temperature: 0, maxTokens: 512, timeoutMs: 1000 },
            dailyRequestLimit: 1,
          }),
        resolveCredential: () =>
          Promise.resolve({ apiKey: "synthetic-scoped-key" }),
        reserveDailyAttempt: () => Promise.resolve(++reservations <= 1),
      },
    );
    if (route.status !== "configured")
      throw new Error("Missing trusted fixture route");
    const bodies: Readonly<Record<string, unknown>>[] = [];
    const fetcher = vi.fn((_input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON request");
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: invalid
                    ? "invalid response"
                    : JSON.stringify({
                        action: "reply",
                        reasonCode: null,
                        text: "Hello! How can I help?",
                      }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const provider = new OpenAiCompatibleChatProvider({
      apiKey: route.credential.apiKey,
      baseUrl: route.baseUrl,
      model: route.model,
      ...route.settings,
    });
    const run = provider.decide(
      {
        systemPrompt: "Use approved information.",
        locale: "en",
        messages: [{ role: "user", text: "Hi!" }],
      },
      undefined,
      () => Promise.resolve(),
      route.beforeAttempt,
    );
    if (invalid)
      await expect(run).rejects.toThrow("model_daily_quota_exhausted");
    else expect(await run).toMatchObject({ action: "reply" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(bodies).toEqual([
      expect.objectContaining({
        model: "gemini-3.1-flash-lite",
        temperature: 0,
        max_tokens: 512,
      }),
    ]);
    expect(reservations).toBe(invalid ? 2 : 1);
  },
);
