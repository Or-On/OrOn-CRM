import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  MetaWhatsAppProvider,
  RoutedMetaWhatsAppProvider,
  SimulatorWhatsAppProvider,
  WhatsAppProviderError,
} from "../src/providers.js";

const request = {
  idempotencyKey: "request-12345678",
  recipient: "+972501234567",
  delivery: { kind: "text" as const, text: "Hello" },
};

function provider(
  fetcher: typeof fetch,
  overrides: Partial<
    ConstructorParameters<typeof MetaWhatsAppProvider>[0]
  > = {},
) {
  return new MetaWhatsAppProvider({
    accessToken: "never-log-token",
    enabled: true,
    fetch: fetcher,
    graphApiVersion: "v26.0",
    phoneNumberId: "1312069101984418",
    wait: () => Promise.resolve(),
    random: () => 0,
    ...overrides,
  });
}

describe("WhatsApp providers", () => {
  const templateVerification = {
    senderPhoneNumberId: "1312069101984418",
    wabaId: "123456789",
    graphApiVersion: "v26.0",
    templateName: "conversation_start",
    language: "he",
    buttonIndices: [0, 1],
    buttonTexts: ["Services", "Help"],
    beforeAttempt: () => Promise.resolve(),
    accessTokenForAttempt: () => Promise.resolve("synthetic-fresh-credential"),
  };
  it("verifies the exact approved template through fixed-host pagination and fresh authority", async () => {
    const beforeAttempt = vi.fn().mockResolvedValue(undefined);
    const accessTokenForAttempt = vi
      .fn()
      .mockResolvedValue("synthetic-fresh-credential");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [],
          paging: {
            next: "https://untrusted.invalid/never-follow",
            cursors: { after: "cursor+1" },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              name: "conversation_start",
              language: "he",
              status: "APPROVED",
              components: [
                {
                  type: "BUTTONS",
                  buttons: [
                    { type: "QUICK_REPLY", text: "Services" },
                    { type: "QUICK_REPLY", text: "Help" },
                  ],
                },
              ],
            },
          ],
        }),
      );
    await expect(
      provider(fetcher).verifyTemplate({
        ...templateVerification,
        beforeAttempt,
        accessTokenForAttempt,
      }),
    ).resolves.toBe(true);
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(accessTokenForAttempt).toHaveBeenCalledTimes(2);
    const requestedUrl = fetcher.mock.calls[1]?.[0];
    if (!(requestedUrl instanceof URL)) throw new Error("Expected fixed URL");
    const url = requestedUrl;
    expect(url.hostname).toBe("graph.facebook.com");
    expect(url.searchParams.get("after")).toBe("cursor+1");
  });
  it.each(["PENDING", "REJECTED", "PAUSED"])(
    "refuses unapproved catalog status %s",
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [
            {
              name: "conversation_start",
              language: "he",
              status,
              components: [
                {
                  type: "BUTTONS",
                  buttons: [
                    { type: "QUICK_REPLY", text: "Services" },
                    { type: "QUICK_REPLY", text: "Help" },
                  ],
                },
              ],
            },
          ],
        }),
      );
      await expect(
        provider(fetcher).verifyTemplate(templateVerification),
      ).resolves.toBe(false);
    },
  );
  it("does not fetch after fresh authority was revoked", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      provider(fetcher).verifyTemplate({
        ...templateVerification,
        beforeAttempt: () => Promise.reject(new Error("revoked")),
      }),
    ).rejects.toThrow("revoked");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Help" },
          { type: "QUICK_REPLY", text: "Services" },
        ],
      },
    ],
    [
      { type: "BODY", text: "Hello {{1}}" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Services" },
          { type: "QUICK_REPLY", text: "Help" },
        ],
      },
    ],
    [
      { type: "HEADER", format: "IMAGE" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Services" },
          { type: "QUICK_REPLY", text: "Help" },
        ],
      },
    ],
  ])(
    "refuses semantic button swaps or unbound template parameters: %j",
    async (...components) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [
            {
              name: "conversation_start",
              language: "he",
              status: "APPROVED",
              components,
            },
          ],
        }),
      );
      await expect(
        provider(fetcher).verifyTemplate(templateVerification),
      ).resolves.toBe(false);
    },
  );
  it("records physical attempt only after fresh credentials and preserves deferred rejection delay", async () => {
    const onAttemptStarted = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("{}", { status: 429, headers: { "retry-after": "100" } }),
      );
    await expect(
      provider(fetcher).send({
        ...request,
        maximumAttempts: 1,
        onAttemptStarted,
        accessTokenForAttempt: () =>
          Promise.reject(new Error("revoked before POST")),
      }),
    ).rejects.toThrow("revoked before POST");
    expect(onAttemptStarted).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      provider(fetcher).send({
        ...request,
        maximumAttempts: 1,
        onAttemptStarted,
      }),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 100000 });
    expect(onAttemptStarted).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("bounds catalog body and refuses repeated cursor", async () => {
    const huge = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(256 * 1024 + 1)));
    await expect(
      provider(huge).verifyTemplate(templateVerification),
    ).rejects.toMatchObject({ code: "media_too_large" });
    const repeated = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        Response.json({
          data: [],
          paging: { next: "untrusted", cursors: { after: "same" } },
        }),
      ),
    );
    await expect(
      provider(repeated).verifyTemplate(templateVerification),
    ).rejects.toMatchObject({ code: "template_catalog_cursor_invalid" });
    expect(repeated).toHaveBeenCalledTimes(2);
  });
  it("sends stable opaque quick-reply payloads at approved button indices", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ messages: [{ id: "wamid.menu.synthetic" }] }),
      );
    await provider(fetcher).send({
      ...request,
      delivery: {
        kind: "template",
        templateName: "conversation_start",
        language: "he",
        parameters: [],
        quickReplies: [
          { index: 0, payload: "menu:generation:services" },
          { index: 1, payload: "menu:generation:support" },
        ],
      },
    });
    const options = fetcher.mock.calls[0]?.[1];
    if (typeof options?.body !== "string")
      throw new Error("Expected JSON body");
    expect(JSON.parse(options.body)).toMatchObject({
      template: {
        name: "conversation_start",
        language: { code: "he" },
        components: [
          {
            type: "button",
            sub_type: "quick_reply",
            index: "0",
            parameters: [
              { type: "payload", payload: "menu:generation:services" },
            ],
          },
          {
            type: "button",
            sub_type: "quick_reply",
            index: "1",
            parameters: [
              { type: "payload", payload: "menu:generation:support" },
            ],
          },
        ],
      },
    });
  });
  it.each([
    [
      { index: 0, payload: "a" },
      { index: 0, payload: "b" },
    ],
    [{ index: -1, payload: "a" }],
    [{ index: 10, payload: "a" }],
    [{ index: 0.5, payload: "a" }],
    [{ index: 0, payload: " " }],
    [{ index: 0, payload: "x".repeat(257) }],
    [{ index: 0, payload: "\u0000" }],
  ])(
    "rejects invalid quick replies before any physical send: %j",
    async (...quickReplies) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        provider(fetcher).send({
          ...request,
          delivery: {
            kind: "template",
            templateName: "conversation_start",
            language: "en",
            parameters: [],
            quickReplies,
          },
        }),
      ).rejects.toThrow("invalid template quick replies");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("defers a long rejection delay without a second physical send", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("{}", { status: 429, headers: { "retry-after": "100" } }),
      );
    const wait = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
    await expect(
      provider(fetcher, { wait }).send(request),
    ).rejects.toMatchObject({
      code: "rate_limit_deferred",
      retryable: true,
      retryAfterMs: 100000,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });
  it("honors HTTP-date Retry-After using the current clock", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 4));
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response("{}", {
            status: 429,
            headers: { "retry-after": "Sun, 04 Oct 2026 00:00:04 GMT" },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ messages: [{ id: "wamid.synthetic" }] }),
        );
      const wait = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
      await provider(fetcher, { wait }).send(request);
      expect(wait).toHaveBeenCalledWith(4000);
    } finally {
      clock.mockRestore();
    }
  });
  it.each([
    ["3", 3000],
    ["invalid", 200],
    ["-1", 200],
  ])(
    "uses bounded Retry-After %s only after explicit rejection",
    async (header, delay) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response("{}", {
            status: 429,
            headers: { "retry-after": header },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ messages: [{ id: "wamid.synthetic" }] }),
        );
      const wait = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
      await expect(provider(fetcher, { wait }).send(request)).resolves.toEqual({
        messageId: "wamid.synthetic",
      });
      expect(wait).toHaveBeenCalledWith(delay);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["null", "[]", "123", '"primitive"', "{broken"])(
    "rejects non-object or malformed media metadata %s before downloading",
    async (body) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body));
      await expect(
        provider(fetcher).downloadMedia({ mediaId: "123456789" }),
      ).rejects.toMatchObject({
        code: "media_metadata_invalid",
        retryable: false,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it("marks the bound inbound read and typing immediately after the ownership guard", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const guard = vi.fn().mockResolvedValue(undefined);
    await provider(fetcher).acknowledgeInbound({
      senderPhoneNumberId: "1312069101984418",
      providerMessageId: "wamid.synthetic",
      beforeAttempt: guard,
    });
    expect(guard).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(jsonBody(fetcher.mock.calls[0]?.[1])) as unknown).toEqual(
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: "wamid.synthetic",
        typing_indicator: { type: "text" },
      },
    );
    expect(guard.mock.invocationCallOrder[0]).toBeLessThan(
      required(fetcher.mock.invocationCallOrder[0]),
    );
  });

  it("never acknowledges a human-owned or unknown-account inbound", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const owned = {
      senderPhoneNumberId: "1312069101984418",
      providerMessageId: "wamid.synthetic",
      beforeAttempt: vi.fn().mockRejectedValue(new Error("human_owned")),
    };
    await expect(provider(fetcher).acknowledgeInbound(owned)).rejects.toThrow(
      "human_owned",
    );
    await expect(
      provider(fetcher).acknowledgeInbound({
        ...owned,
        senderPhoneNumberId: "999",
      }),
    ).rejects.toMatchObject({ code: "sender_configuration_changed" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not retry acknowledgement rate limits or leak response bodies", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("limited", { status: 429 }));
    await expect(
      provider(fetcher).acknowledgeInbound({
        senderPhoneNumberId: "1312069101984418",
        providerMessageId: "wamid.synthetic",
        beforeAttempt: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({
      code: "acknowledgement_http_429",
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("bounds acknowledgement HTTP time and permits no real request in tests", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    await expect(
      provider(fetcher, { timeoutMs: 5 }).acknowledgeInbound({
        senderPhoneNumberId: "1312069101984418",
        providerMessageId: "wamid.synthetic",
        beforeAttempt: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({ code: "acknowledgement_transport_error" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("selects the bound Meta account and refuses an unknown sender before HTTP", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "sent-1" }] }), {
        status: 200,
      }),
    );
    const routed = new RoutedMetaWhatsAppProvider([
      {
        enabled: true,
        accessToken: "first-token",
        graphApiVersion: "v26.0",
        phoneNumberId: "111",
        fetch: fetcher,
      },
      {
        enabled: true,
        accessToken: "second-token",
        graphApiVersion: "v23.0",
        phoneNumberId: "222",
        fetch: fetcher,
      },
    ]);
    await expect(
      routed.send({ ...request, senderPhoneNumberId: "222" }),
    ).resolves.toEqual({ messageId: "sent-1" });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://graph.facebook.com/v23.0/222/messages",
    );
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer second-token");
    await expect(
      routed.send({ ...request, senderPhoneNumberId: "333" }),
    ).rejects.toMatchObject({ code: "sender_configuration_changed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("downloads inbound media with the bound account token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((url) =>
      Promise.resolve(
        (typeof url === "string"
          ? url
          : url instanceof URL
            ? url.href
            : url.url
        ).includes("/123")
          ? Response.json({ url: "https://lookaside.fbsbx.com/fixture" })
          : new Response(Buffer.from("fictional-image"), {
              headers: { "content-type": "image/jpeg" },
            }),
      ),
    );
    const routed = new RoutedMetaWhatsAppProvider([
      {
        enabled: true,
        accessToken: "first-token",
        graphApiVersion: "v26.0",
        phoneNumberId: "111",
        fetch: fetcher,
      },
      {
        enabled: true,
        accessToken: "second-token",
        graphApiVersion: "v23.0",
        phoneNumberId: "222",
        fetch: fetcher,
      },
    ]);
    const media = await routed.downloadMedia({
      mediaId: "123",
      senderPhoneNumberId: "222",
    });
    expect(media.contentType).toBe("image/jpeg");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://graph.facebook.com/v23.0/123",
    );
    for (const [, init] of fetcher.mock.calls)
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer second-token",
      );
  });

  it("rechecks ownership after a 429 delay before a second HTTP request", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 429 }));
    const beforeAttempt = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new WhatsAppProviderError("outbound_eligibility_changed", false),
      );
    await expect(
      provider(fetcher, { maxAttempts: 3 }).send({ ...request, beforeAttempt }),
    ).rejects.toMatchObject({
      code: "outbound_eligibility_changed",
      retryable: false,
    });
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not start HTTP after a stale claim or revoked evidence check", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      provider(fetcher).send({
        ...request,
        beforeAttempt: () =>
          Promise.reject(
            new WhatsAppProviderError("ai_evidence_changed", false),
          ),
      }),
    ).rejects.toMatchObject({ code: "ai_evidence_changed", retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 100, error_subcode: 33 }, 400, "resource_access"],
    [
      {
        code: 100,
        message: "Allows the endpoint to be called by apps with the capability",
      },
      400,
      "app_capability",
    ],
    [
      {
        code: 100,
        error_data: {
          details: "Only test phone numbers can use the hello_world template",
        },
      },
      400,
      "test_template",
    ],
    [{ code: 132001 }, 400, "template_missing"],
    [{ code: 132000 }, 400, "template_parameters"],
    [{ code: 131047 }, 400, "customer_service_window"],
    [{ code: 190 }, 401, "authentication"],
    [{ code: 131005 }, 403, "permission"],
    [{ code: 100 }, 400, "invalid_parameter"],
    [{ code: 130429 }, 429, "rate_limit"],
  ] as const)("retains safe details for %j", async (error, status, reason) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ error }), { status })),
      );
    await expect(
      provider(fetcher, { maxAttempts: 2 }).send(request),
    ).rejects.toMatchObject({
      diagnostic: {
        version: 1,
        httpStatus: status,
        metaCode: error.code,
        reason,
        retryable: status === 429,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(status === 429 ? 2 : 1);
  });

  it("cannot echo secrets or PII through any provider error field", async () => {
    const privateText =
      "never-log-token private-message-body +972501234567 private@example.invalid <script>alert(1)</script>";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: privateText,
            error_subcode: privateText,
            message: privateText,
            error_user_title: privateText,
            error_user_msg: privateText,
            fbtrace_id: privateText,
            error_data: { details: privateText },
          },
        }),
        { status: 400 },
      ),
    );
    const error: unknown = await provider(fetcher)
      .send(request)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "meta_http_error",
      diagnostic: {
        metaCode: null,
        metaSubcode: null,
        reason: "unknown",
        httpStatus: 400,
      },
    });
    const output = JSON.stringify(error) + String(error);
    for (const value of privateText.split(" "))
      expect(output).not.toContain(value);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("handles non-JSON rejections without retaining their body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("<html>private-token</html>", { status: 403 }),
      );
    await expect(provider(fetcher).send(request)).rejects.toMatchObject({
      code: "meta_http_error",
      diagnostic: { httpStatus: 403, metaCode: null, reason: "unknown" },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("maps a null successful response to an invalid response, not a network retry", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("null", { status: 200 }));
    await expect(provider(fetcher).send(request)).rejects.toMatchObject({
      code: "delivery_outcome_unknown",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("keeps simulator deterministic and network-free", async () => {
    const simulator = new SimulatorWhatsAppProvider();
    expect(await simulator.send(request)).toEqual(
      await simulator.send(request),
    );
  });

  it("downloads allowlisted Meta media with feature rechecks and base64 checksum validation", async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]);
    const expectedSha256 = createHash("sha256").update(bytes).digest("base64");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123",
            mime_type: "image/jpeg",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(bytes.byteLength),
          },
        }),
      );
    const beforeAttempt = vi.fn<() => Promise<void>>().mockResolvedValue();
    await expect(
      provider(fetcher).downloadMedia({
        mediaId: "123456789",
        expectedMimeType: "image/jpeg",
        expectedSha256,
        beforeAttempt,
      }),
    ).resolves.toMatchObject({
      bytes,
      contentType: "image/jpeg",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls)
      expect(call[1]?.headers).toEqual({
        authorization: "Bearer never-log-token",
      });
  });

  it("rejects a provider-controlled media URL outside the Meta allowlist", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ url: "https://evil.invalid/private" }), {
        status: 200,
      }),
    );
    await expect(
      provider(fetcher).downloadMedia({ mediaId: "123456789" }),
    ).rejects.toMatchObject({ code: "media_url_invalid", retryable: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps the real-media boundary off when the provider kill switch is off", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      provider(fetcher, { enabled: false }).downloadMedia({
        mediaId: "123456789",
      }),
    ).rejects.toMatchObject({ code: "provider_disabled", retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses real delivery when the boundary kill switch is off", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      provider(fetcher, { enabled: false }).send(request),
    ).rejects.toMatchObject({
      code: "provider_disabled",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses missing credentials and invalid recipients", async () => {
    await expect(
      provider(vi.fn(), { accessToken: undefined }).send(request),
    ).rejects.toMatchObject({
      code: "provider_not_configured",
    });
    await expect(
      provider(vi.fn()).send({ ...request, recipient: "0501234567" }),
    ).rejects.toThrow("E.164");
  });

  it("sends text and approved template payloads", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), {
          status: 200,
        }),
      ),
    );
    expect(await provider(fetcher).send(request)).toEqual({
      messageId: "wamid.ok",
    });
    await provider(fetcher).send({
      ...request,
      delivery: {
        kind: "template",
        templateName: "order_update",
        language: "he",
        parameters: ["42"],
      },
    });
    const firstInput = fetcher.mock.calls[0]?.[0];
    const firstUrl =
      firstInput instanceof Request
        ? firstInput.url
        : firstInput instanceof URL
          ? firstInput.href
          : firstInput;
    expect(firstUrl).toContain("/v26.0/1312069101984418/messages");
    const templateBody = fetcher.mock.calls[1]?.[1]?.body;
    if (typeof templateBody !== "string")
      throw new TypeError("template request body must be a string");
    expect(JSON.parse(templateBody)).toMatchObject({
      type: "template",
    });
  });

  it.each([400, 401, 403])(
    "maps permanent Meta %s errors without retry",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { code: status } }), { status }),
        );
      await expect(provider(fetcher).send(request)).rejects.toBeInstanceOf(
        WhatsAppProviderError,
      );
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each([429])(
    "retries transient Meta %s responses with a bound",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { code: status } }), { status }),
        )
        .mockResolvedValue(
          new Response(JSON.stringify({ messages: [{ id: "wamid.retry" }] }), {
            status: 200,
          }),
        );
      expect(await provider(fetcher).send(request)).toEqual({
        messageId: "wamid.retry",
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("maps bounded timeouts without leaking request data", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const failure = provider(fetcher, { maxAttempts: 1, timeoutMs: 1 }).send(
      request,
    );
    await expect(failure).rejects.toMatchObject({
      code: "delivery_outcome_unknown",
      retryable: false,
      message: "WhatsApp provider request failed (delivery_outcome_unknown)",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([500, 502, 503])(
    "does not replay ambiguous Meta %s responses",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("{}", { status }));
      await expect(provider(fetcher).send(request)).rejects.toMatchObject({
        code: "delivery_outcome_unknown",
        retryable: false,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("does not replay a lost response even when multiple attempts are configured", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("connection lost"));
    await expect(
      provider(fetcher, { maxAttempts: 5 }).send(request),
    ).rejects.toMatchObject({
      code: "delivery_outcome_unknown",
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("refuses queued sender mismatch before HTTP", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      provider(fetcher).send({ ...request, senderPhoneNumberId: "999999999" }),
    ).rejects.toMatchObject({
      code: "sender_configuration_changed",
      retryable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never exposes secrets, message bodies, or full recipients in failures", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 401, message: "provider detail" } }),
          { status: 401 },
        ),
      );
    const error = await provider(fetcher)
      .send({
        ...request,
        delivery: { kind: "text", text: "private-message-body" },
      })
      .catch((caught: unknown) => caught);
    const rendered = String(error);
    expect(rendered).not.toContain("never-log-token");
    expect(rendered).not.toContain("private-message-body");
    expect(rendered).not.toContain("+972501234567");
  });
});

function jsonBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string")
    throw new Error("Expected JSON request body");
  return init.body;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}
