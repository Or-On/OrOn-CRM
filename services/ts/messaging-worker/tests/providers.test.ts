import { describe, expect, it, vi } from "vitest";

import {
  MetaWhatsAppProvider,
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
