import { describe, expect, it } from "vitest";
import { assertSessionModelProjection } from "./session-agent-admission.js";

describe("session Agent model metadata eligibility", () => {
  const scope = { tenantId: "tenant", agentVersionId: "version" };
  const binding = {
    ...scope,
    published: true,
    validationStatus: "valid",
    authorized: true,
    modelConfigurationId: "configuration",
  };
  const configuration = {
    id: "configuration",
    tenantId: scope.tenantId,
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    credentialId: "credential",
    settings: { temperature: 0, maxTokens: 1000, timeoutMs: 10000 },
    dailyRequestLimit: 100,
  };
  const modelCredential = {
    id: "credential",
    tenantId: scope.tenantId,
    kind: "llm_api_key_v2",
    envelopePresent: true,
    keyVersion: 1,
  };
  const route = { binding, configuration, modelCredential };
  it("accepts eligible metadata without decrypting or proving physical readiness", () => {
    expect(() => assertSessionModelProjection(route, scope)).not.toThrow();
  });
  it("preserves legacy only for an explicitly absent model binding", () => {
    expect(() =>
      assertSessionModelProjection(
        { binding: { ...binding, modelConfigurationId: null } },
        scope,
      ),
    ).not.toThrow();
    expect(() => assertSessionModelProjection(null, scope)).toThrow();
  });
  it("rejects foreign or revoked server bindings", () => {
    for (const mutation of [
      { tenantId: "foreign" },
      { agentVersionId: "foreign" },
      { published: false },
      { authorized: false },
      { validationStatus: "invalid" },
    ])
      expect(() =>
        assertSessionModelProjection(
          { ...route, binding: { ...binding, ...mutation } },
          scope,
        ),
      ).toThrow();
  });
  it("rejects disabled, malformed or unsafe explicit configurations", () => {
    for (const mutation of [
      { enabled: false },
      { id: "foreign" },
      { tenantId: "foreign" },
      { provider: "user-url" },
      { model: "https://example.invalid" },
      { settings: { baseUrl: "https://example.invalid" } },
      { settings: { timeoutMs: 60001 } },
      { settings: { maxTokens: 0 } },
      { dailyRequestLimit: 0 },
    ])
      expect(() =>
        assertSessionModelProjection(
          { ...route, configuration: { ...configuration, ...mutation } },
          scope,
        ),
      ).toThrow();
  });
  it("rejects missing or foreign typed credential metadata", () => {
    for (const mutation of [
      { id: "foreign" },
      { tenantId: "foreign" },
      { kind: "channel_token" },
      { envelopePresent: false },
      { keyVersion: 0 },
    ])
      expect(() =>
        assertSessionModelProjection(
          { ...route, modelCredential: { ...modelCredential, ...mutation } },
          scope,
        ),
      ).toThrow();
  });
});
