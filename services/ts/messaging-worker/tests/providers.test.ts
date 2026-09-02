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

  it.each([429, 500, 503])(
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
      code: "timeout",
      message: "WhatsApp provider request failed (timeout)",
    });
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
