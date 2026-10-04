import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  channelCredentialKey,
  channelCredentialKeys,
  createChannelCredentialResolver,
  sealChannelCredential,
} from "../src/channel-credentials.js";
import { MetaWhatsAppProvider } from "../src/providers.js";

describe("WA v2 credential boundaries", () => {
  const key = Buffer.alloc(32, 17);
  const binding = {
    tenantId: randomUUID(),
    channelId: randomUUID(),
    credentialId: randomUUID(),
  };
  it("loads only explicit versioned keys and rejects legacy or duplicate versions", () => {
    const ring = channelCredentialKeys({
      CREDENTIAL_ENCRYPTION_KEY: key.toString("base64"),
      CREDENTIAL_ENCRYPTION_KEYRING: JSON.stringify({
        "rotated:wa:v2": Buffer.alloc(32, 19).toString("base64"),
      }),
    });
    expect(ring.size).toBe(2);
    expect(() =>
      channelCredentialKeys({
        CREDENTIAL_ENCRYPTION_KEYRING: JSON.stringify({
          "env:v1": key.toString("base64"),
        }),
      }),
    ).toThrow("credential_keyring_invalid");
    expect(() =>
      channelCredentialKeys({
        CREDENTIAL_ENCRYPTION_KEY: key.toString("base64"),
        CREDENTIAL_ENCRYPTION_KEYRING: JSON.stringify({
          "env:wa:v2": key.toString("base64"),
        }),
      }),
    ).toThrow("credential_keyring_invalid");
  });
  it("round trips explicit canonical keys and rejects noncanonical encodings", () => {
    expect(channelCredentialKey(key.toString("base64"))).toEqual(key);
    expect(() => channelCredentialKey(key.toString("base64") + " ")).toThrow(
      "credential_key_invalid",
    );
    expect(channelCredentialKey(undefined)).toBeUndefined();
  });
  it("isolates cache by tenant/channel/ref and revalidates envelope revocation and rotation", () => {
    const resolve = createChannelCredentialResolver(
      new Map([
        ["env:wa:v2", key],
        ["test:rotated", Buffer.alloc(32, 19)],
      ]),
    );
    const envelope = sealChannelCredential(binding, "fictional-token-one", key);
    expect(resolve(envelope)).toBe("fictional-token-one");
    expect(resolve(envelope)).toBe("fictional-token-one");
    for (const field of ["tenantId", "channelId", "credentialId"] as const)
      expect(() => resolve({ ...envelope, [field]: randomUUID() })).toThrow(
        "channel_credential_unavailable",
      );
    expect(() =>
      resolve({
        ...envelope,
        ciphertext: null,
        nonce: null,
        algorithm: null,
        keyVersion: null,
      }),
    ).toThrow("channel_credential_unavailable");
    expect(() => resolve({ ...envelope, keyVersion: "env:v1" })).toThrow(
      "channel_credential_unavailable",
    );
    expect(() => resolve({ ...envelope, kind: "email_token" })).toThrow(
      "channel_credential_unavailable",
    );
    const rotated = sealChannelCredential(
      binding,
      "fictional-token-two",
      Buffer.alloc(32, 19),
      "test:rotated",
    );
    expect(resolve(rotated)).toBe("fictional-token-two");
    expect(() =>
      resolve({
        ...envelope,
        ciphertext: "00" + (envelope.ciphertext ?? "").slice(2),
      }),
    ).toThrow("channel_credential_unavailable");
  });
  it("uses fresh credential per explicit 429 physical attempt and never falls back after denial", async () => {
    const headers: string[] = [];
    const execute = vi
      .fn<typeof fetch>()
      .mockImplementation((_url, options) => {
        headers.push(new Headers(options?.headers).get("authorization") ?? "");
        return Promise.resolve(
          headers.length === 1
            ? new Response("{}", { status: 429 })
            : Response.json({ messages: [{ id: "wamid.synthetic" }] }),
        );
      });
    const provider = new MetaWhatsAppProvider({
      enabled: true,
      accessToken: "forbidden-legacy-fallback",
      phoneNumberId: "12345",
      graphApiVersion: "v26.0",
      fetch: execute,
      wait: () => Promise.resolve(),
    });
    const resolve = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("fictional-one")
      .mockResolvedValueOnce("fictional-two");
    const request = {
      idempotencyKey: "fictional-key-123",
      recipient: "+12025551234",
      delivery: { kind: "text" as const, text: "Fictional" },
      accessTokenForAttempt: resolve,
    };
    await provider.send(request);
    expect(headers).toEqual(["Bearer fictional-one", "Bearer fictional-two"]);
    execute.mockClear();
    resolve.mockRejectedValue(new TypeError("channel_credential_unavailable"));
    await expect(provider.send(request)).rejects.toThrow(
      "channel_credential_unavailable",
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it("resolves typing credentials freshly and refuses a revoked explicit reference before HTTP", async () => {
    const execute = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const provider = new MetaWhatsAppProvider({
      enabled: true,
      accessToken: "forbidden-legacy",
      phoneNumberId: "12345",
      graphApiVersion: "v26.0",
      fetch: execute,
    });
    const accessTokenForAttempt = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValue("fictional-typing");
    const request = {
      senderPhoneNumberId: "12345",
      providerMessageId: "wamid.synthetic",
      beforeAttempt: () => Promise.resolve(),
      accessTokenForAttempt,
    };
    await provider.acknowledgeInbound(request);
    expect(
      new Headers(execute.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer fictional-typing");
    execute.mockClear();
    accessTokenForAttempt.mockRejectedValue(
      new Error("channel_credential_unavailable"),
    );
    await expect(provider.acknowledgeInbound(request)).rejects.toThrow(
      "channel_credential_unavailable",
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it("refreshes credentials separately for metadata and private media GET", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=",
      "base64",
    );
    const execute = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          url: "https://lookaside.fbsbx.com/fictional",
          mime_type: "image/png",
        }),
      )
      .mockResolvedValueOnce(
        new Response(bytes, { headers: { "content-type": "image/png" } }),
      );
    const provider = new MetaWhatsAppProvider({
      enabled: true,
      accessToken: "forbidden-legacy",
      phoneNumberId: "12345",
      graphApiVersion: "v26.0",
      fetch: execute,
    });
    const accessTokenForAttempt = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("fictional-metadata")
      .mockResolvedValueOnce("fictional-media");
    await provider.downloadMedia({ mediaId: "12345", accessTokenForAttempt });
    expect(
      execute.mock.calls.map((call) =>
        new Headers(call[1]?.headers).get("authorization"),
      ),
    ).toEqual(["Bearer fictional-metadata", "Bearer fictional-media"]);
  });
});
