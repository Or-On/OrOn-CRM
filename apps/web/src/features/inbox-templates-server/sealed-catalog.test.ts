import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import { sealChannelCredential } from "@or-on/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const binding = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  channelId: "22222222-2222-4222-8222-222222222222",
  credentialId: "33333333-3333-4333-8333-333333333333",
};
const key = randomBytes(32);
function row() {
  const envelope = sealChannelCredential(binding, "synthetic-token", key);
  return {
    tenant_id: binding.tenantId,
    channel_id: binding.channelId,
    credential_id: binding.credentialId,
    phone_id: "111",
    waba_id: "12345",
    graph_version: "v23.0",
    credential_kind: envelope.kind,
    algorithm: envelope.algorithm,
    key_version: envelope.keyVersion,
    ciphertext: envelope.ciphertext,
    nonce: envelope.nonce,
  };
}
function sqlFor(value: unknown) {
  return vi.fn(() =>
    Promise.resolve([value]),
  ) as unknown as postgres.TransactionSql;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("sealed human-operator template catalog", () => {
  it("decrypts only the canonical channel envelope and detects re-sealing unchanged plaintext", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", key.toString("base64"));
    const { templateAccount } = await import("./index");
    const first = await templateAccount(sqlFor(row()), "conversation");
    const second = await templateAccount(sqlFor(row()), "conversation");
    expect(first.accessToken).toBe("synthetic-token");
    expect(second.accessToken).toBe(first.accessToken);
    expect(second.bindingFingerprint).not.toBe(first.bindingFingerprint);
  });

  it.each(["tenant", "channel", "credential", "tag", "key", "missing"])(
    "rejects %s envelope corruption before any Graph request or global-token fallback",
    async (change) => {
      vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", key.toString("base64"));
      vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "must-not-fallback");
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const value = row();
      if (change === "tenant")
        value.tenant_id = "44444444-4444-4444-8444-444444444444";
      if (change === "channel")
        value.channel_id = "44444444-4444-4444-8444-444444444444";
      if (change === "credential")
        value.credential_id = "44444444-4444-4444-8444-444444444444";
      if (change === "tag")
        value.ciphertext = "00" + (value.ciphertext ?? "").slice(2);
      if (change === "key") value.key_version = "unknown-version";
      if (change === "missing") value.ciphertext = null;
      const { templateAccount } = await import("./index");
      await expect(
        templateAccount(sqlFor(value), "conversation"),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("rejects mid-response credential rotation and never returns stale catalog", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", key.toString("base64"));
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [] }))),
    );
    vi.stubGlobal("fetch", fetcher);
    const { templateAccount, listConversationTemplates } =
      await import("./index");
    const first = await templateAccount(sqlFor(row()), "conversation");
    const rotated = await templateAccount(sqlFor(row()), "conversation");
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(rotated);
    await expect(listConversationTemplates(resolve, null)).rejects.toThrow(
      "binding changed",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("reauthorizes cache hits and rejects revoked access without another Graph request", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", key.toString("base64"));
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [] }))),
    );
    vi.stubGlobal("fetch", fetcher);
    const { templateAccount, listConversationTemplates } =
      await import("./index");
    const account = await templateAccount(sqlFor(row()), "conversation");
    await listConversationTemplates(() => Promise.resolve(account), null);
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(account)
      .mockRejectedValueOnce(new Error("revoked"));
    await expect(listConversationTemplates(resolve, null)).rejects.toThrow(
      "revoked",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      listConversationTemplates(
        () => Promise.reject(new Error("revoked")),
        null,
      ),
    ).rejects.toThrow("revoked");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
