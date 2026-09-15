import { describe, expect, it, vi } from "vitest";

import { fieldServiceRuntimeReadiness } from "./runtime-readiness";

const validKeys = {
  FIELD_CIPHER_LOCAL_KEY: Buffer.alloc(32, 7).toString("base64"),
  BLIND_INDEX_KEY: Buffer.alloc(32, 9).toString("base64"),
};

describe("field-service runtime readiness", () => {
  it("requires a validated writable absolute private-storage root", async () => {
    const accessCheck = vi.fn().mockResolvedValue(undefined);

    const readiness = await fieldServiceRuntimeReadiness(
      {
        ...validKeys,
        ENABLE_WHATSAPP_AI: "true",
        LLM_PROVIDER: "openai-compat",
        LLM_API_KEY: "synthetic-key",
        LLM_BASE_URL: "https://example.invalid/v1",
        LLM_MODEL: "synthetic-model",
        ARTIFACTS_BACKEND: "local",
        ARTIFACTS_LOCAL_ROOT: "/var/lib/oron/objects",
      },
      accessCheck,
    );

    expect(readiness).toEqual({
      aiProviderConfigured: true,
      protectedFieldsConfigured: true,
      privateStorageConfigured: true,
      storageBackend: "local",
    });
    expect(accessCheck).toHaveBeenCalledOnce();
  });

  it("does not report the implicit local default or invalid keys as ready", async () => {
    const accessCheck = vi.fn().mockResolvedValue(undefined);

    const readiness = await fieldServiceRuntimeReadiness(
      {
        FIELD_CIPHER_LOCAL_KEY: "invalid",
        BLIND_INDEX_KEY: "invalid",
      },
      accessCheck,
    );

    expect(readiness.privateStorageConfigured).toBe(false);
    expect(readiness.protectedFieldsConfigured).toBe(false);
    expect(readiness.storageBackend).toBe("unconfigured");
    expect(accessCheck).not.toHaveBeenCalled();
  });

  it("fails closed when the configured storage root is not writable", async () => {
    const readiness = await fieldServiceRuntimeReadiness(
      {
        ...validKeys,
        ARTIFACTS_BACKEND: "local",
        ARTIFACTS_LOCAL_ROOT: "/var/lib/oron/objects",
      },
      vi.fn().mockRejectedValue(new Error("denied")),
    );

    expect(readiness.privateStorageConfigured).toBe(false);
  });
});
