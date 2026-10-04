import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  createModelCredentialResolver,
  modelCredentialKeys,
  sealModelCredential,
} from "../src/model-credentials.js";

it("authenticates tenant, configuration, credential and provider on cache hits", () => {
  const key = Buffer.alloc(32, 23);
  const keys = modelCredentialKeys({
    CREDENTIAL_ENCRYPTION_KEY: key.toString("base64"),
  });
  const resolve = createModelCredentialResolver(keys);
  const binding = {
    tenantId: randomUUID(),
    modelConfigurationId: randomUUID(),
    credentialId: randomUUID(),
    provider: "gemini" as const,
  };
  const envelope = sealModelCredential(binding, "fictional-first", key);
  expect(resolve(envelope).apiKey).toBe("fictional-first");
  expect(resolve(envelope).apiKey).toBe("fictional-first");
  for (const changed of [
    { tenantId: randomUUID() },
    { modelConfigurationId: randomUUID() },
    { credentialId: randomUUID() },
    { provider: "openai" as const },
    { kind: "api_key" },
    { algorithm: "aes-256-gcm" },
    { keyVersion: "env:v1" },
    { ciphertext: null },
    { nonce: "00".repeat(12) },
  ])
    expect(() => resolve({ ...envelope, ...changed })).toThrow();
  const rotated = sealModelCredential(binding, "fictional-second", key);
  expect(resolve(rotated).apiKey).toBe("fictional-second");
  expect(resolve(rotated).fingerprint).not.toBe(resolve(envelope).fingerprint);
  expect(() =>
    createModelCredentialResolver(
      new Map([["env:model:v2", Buffer.alloc(32, 24)]]),
    )(envelope),
  ).toThrow();
});

it("refuses legacy email envelopes and malformed keyrings without plaintext fallback", () => {
  expect(() =>
    modelCredentialKeys({
      CREDENTIAL_ENCRYPTION_KEYRING: '{"env:v1":"unused"}',
    }),
  ).toThrow("credential_keyring_invalid");
  expect(() =>
    modelCredentialKeys({ CREDENTIAL_ENCRYPTION_KEY: "invalid" }),
  ).toThrow("credential_key_invalid");
});
