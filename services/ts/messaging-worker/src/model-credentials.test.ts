import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createModelCredentialResolver,
  modelCredentialKeys,
  sealModelCredential,
} from "./model-credentials.js";

const binding = () => ({
  tenantId: randomUUID(),
  modelConfigurationId: randomUUID(),
  credentialId: randomUUID(),
  provider: "gemini" as const,
});

describe("model-specific bound credential envelope", () => {
  it("decrypts a bound v2 model credential and serves identical bounded cache hits", () => {
    const key = randomBytes(32),
      envelope = sealModelCredential(binding(), "synthetic-model-key", key);
    const resolve = createModelCredentialResolver(
      new Map([["env:model:v2", key]]),
    );
    expect(resolve(envelope)).toEqual(resolve(envelope));
    expect(resolve(envelope).apiKey).toBe("synthetic-model-key");
    expect(resolve(envelope).fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("rejects tenant/configuration/credential/provider substitution and authenticated tampering", () => {
    const key = randomBytes(32),
      envelope = sealModelCredential(binding(), "synthetic-model-key", key);
    const resolve = createModelCredentialResolver(
      new Map([["env:model:v2", key]]),
    );
    for (const patch of [
      { tenantId: randomUUID() },
      { modelConfigurationId: randomUUID() },
      { credentialId: randomUUID() },
      { provider: "openai" as const },
      { ciphertext: "ff" + (envelope.ciphertext?.slice(2) ?? "") },
      { nonce: "ff" + (envelope.nonce?.slice(2) ?? "") },
      { kind: "whatsapp_access_token_v2" },
      { algorithm: "aes-256-gcm" },
      { keyVersion: "env:v1" },
      { ciphertext: null },
    ])
      expect(() => resolve({ ...envelope, ...patch })).toThrow();
  });
  it("does not keep a removed/rotated key usable through its cache", () => {
    const key = randomBytes(32),
      keys = new Map([["env:model:v2", key]]);
    const envelope = sealModelCredential(binding(), "synthetic-model-key", key);
    const resolve = createModelCredentialResolver(keys);
    const initial = resolve(envelope);
    keys.delete("env:model:v2");
    expect(() => resolve(envelope)).toThrow();
    keys.set("env:model:v2", randomBytes(32));
    expect(() => resolve(envelope)).toThrow();
    keys.set("env:model:v2", key);
    const rotated = sealModelCredential(binding(), "synthetic-new-key", key);
    expect(resolve(rotated).fingerprint).not.toBe(initial.fingerprint);
  });
  it("accepts explicit canonical keys and refuses unsupported legacy/duplicate keyrings", () => {
    const encoded = randomBytes(32).toString("base64");
    expect(
      modelCredentialKeys({ CREDENTIAL_ENCRYPTION_KEY: encoded }).size,
    ).toBe(1);
    expect(modelCredentialKeys({}).size).toBe(0);
    for (const ring of [
      "[]",
      JSON.stringify({ "env:v1": encoded }),
      JSON.stringify({ "env:model:v2": encoded }),
    ]) {
      expect(() =>
        modelCredentialKeys({
          CREDENTIAL_ENCRYPTION_KEY: encoded,
          CREDENTIAL_ENCRYPTION_KEYRING: ring,
        }),
      ).toThrow();
    }
    expect(() =>
      sealModelCredential(binding(), "unsafe\nheader", randomBytes(32)),
    ).toThrow();
    expect(() =>
      sealModelCredential(binding(), "synthetic", randomBytes(32), "env:v1"),
    ).toThrow();
  });
});
