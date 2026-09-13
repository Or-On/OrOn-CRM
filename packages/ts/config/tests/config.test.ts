import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  configDiagnostics,
  loadConfig,
} from "../src/index.js";

describe("loadConfig", () => {
  it("validates the public metadata origin without credentials or paths", () => {
    expect(loadConfig({}).publicSiteUrl).toBe("http://127.0.0.1:3000");
    expect(
      loadConfig({ PUBLIC_SITE_URL: "https://example.invalid" }).publicSiteUrl,
    ).toBe("https://example.invalid");
    for (const url of [
      "javascript:alert(1)",
      "https://user:secret@example.invalid",
      "https://example.invalid/path",
      "https://example.invalid/?token=x",
    ]) {
      expect(() => loadConfig({ PUBLIC_SITE_URL: url })).toThrow(
        ConfigurationError,
      );
    }
  });
  it("defaults every real-provider action to disabled", () => {
    const config = loadConfig({});

    expect(config.enableRealTelephony).toBe(false);
    expect(config.enableRealVoiceProviders).toBe(false);
    expect(config.enableRealWhatsApp).toBe(false);
    expect(config.enableWhatsAppAutoCalls).toBe(false);
    expect(config.dispatcherUrl).toBe("http://127.0.0.1:8082");
  });

  it("requires PostgreSQL when requested", () => {
    expect(() => loadConfig({}, { requireDatabase: true })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      loadConfig(
        { DATABASE_URL: "sqlite:///unsafe.db" },
        { requireDatabase: true },
      ),
    ).toThrow("must be a PostgreSQL URL");
  });

  it("requires the dedicated messaging PostgreSQL connection when requested", () => {
    expect(() => loadConfig({}, { requireMessagingDatabase: true })).toThrow(
      "MESSAGING_DATABASE_URL",
    );
    expect(
      loadConfig(
        {
          MESSAGING_DATABASE_URL:
            "postgresql://platform_messaging:secret@localhost/platform",
        },
        { requireMessagingDatabase: true },
      ).messagingDatabaseUrl,
    ).toContain("platform_messaging");
  });

  it("redacts connection strings and provider secrets from diagnostics", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://platform:do-not-print@localhost/platform",
      MESSAGING_DATABASE_URL:
        "postgresql://platform_messaging:also-do-not-print@localhost/platform",
      LIVEKIT_API_SECRET: "livekit-secret",
      WHATSAPP_ACCESS_TOKEN: "whatsapp-secret",
      LLM_API_KEY: "llm-secret",
      AUTH_TOKEN_PEPPER: "auth-token-pepper-with-thirty-two-characters",
      AUTH_SERVICE_SECRET: "auth-service-secret-with-thirty-two-characters",
      AUTH_DUMMY_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=1$dummy$dummy",
    });

    const rendered = JSON.stringify(configDiagnostics(config));
    expect(rendered).not.toContain("do-not-print");
    expect(rendered).not.toContain("also-do-not-print");
    expect(rendered).not.toContain("livekit-secret");
    expect(rendered).not.toContain("whatsapp-secret");
    expect(rendered).not.toContain("llm-secret");
    expect(rendered).not.toContain("auth-token-pepper");
    expect(rendered).not.toContain("auth-service-secret");
    expect(rendered).toContain("[REDACTED]");
  });

  it("requires complete authentication secrets when requested", () => {
    expect(() => loadConfig({}, { requireAuth: true })).toThrow(
      "AUTH_TOKEN_PEPPER",
    );
  });

  it("refuses incomplete real WhatsApp configuration", () => {
    expect(() =>
      loadConfig(
        { ENABLE_REAL_WHATSAPP: "true", WHATSAPP_ACCESS_TOKEN: "token" },
        { requireWhatsApp: true },
      ),
    ).toThrow("real WhatsApp requires");
  });

  it("accepts explicit complete real WhatsApp configuration", () => {
    const config = loadConfig(
      {
        ENABLE_REAL_WHATSAPP: "true",
        WHATSAPP_ACCESS_TOKEN: "token",
        WHATSAPP_APP_SECRET: "1234567890123456",
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token-long-enough",
        WHATSAPP_PHONE_NUMBER_ID: "1312069101984418",
        WHATSAPP_WABA_ID: "1507601250680263",
        WHATSAPP_GRAPH_API_VERSION: "v26.0",
      },
      { requireWhatsApp: true },
    );
    expect(config.enableRealWhatsApp).toBe(true);
    expect(config.whatsApp.phoneNumberId).toBe("1312069101984418");
  });

  it("normalizes the shared Python-style log level", () => {
    expect(loadConfig({ LOG_LEVEL: "INFO" }).logLevel).toBe("info");
  });

  it("requires the shared OpenAI-compatible LLM configuration when WhatsApp AI is enabled", () => {
    expect(() => loadConfig({ ENABLE_WHATSAPP_AI: "true" })).toThrow(
      "WhatsApp AI requires LLM_PROVIDER=openai-compat",
    );
    expect(
      loadConfig({
        ENABLE_WHATSAPP_AI: "true",
        LLM_PROVIDER: "openai-compat",
        LLM_API_KEY: "test-key",
        LLM_BASE_URL:
          "https://generativelanguage.googleapis.com/v1beta/openai/",
        LLM_MODEL: "gemini-2.5-flash",
      }).enableWhatsAppAi,
    ).toBe(true);
  });

  it("requires both Stripe secrets before real billing starts", () => {
    expect(() =>
      loadConfig({ ENABLE_REAL_BILLING: "true", STRIPE_SECRET_KEY: "sk_test" }),
    ).toThrow("real billing requires");
  });

  it("requires every safety gate before WhatsApp can start calls", () => {
    expect(() => loadConfig({ ENABLE_WHATSAPP_AUTO_CALLS: "true" })).toThrow(
      "WhatsApp automatic calls require",
    );

    const config = loadConfig({
      ENABLE_WHATSAPP_AUTO_CALLS: "true",
      ENABLE_WHATSAPP_AI: "true",
      ENABLE_REAL_WHATSAPP: "true",
      ENABLE_REAL_TELEPHONY: "true",
      ENABLE_REAL_VOICE_PROVIDERS: "true",
      AUTH_SERVICE_SECRET: "fictional-service-secret-at-least-32-bytes",
      LLM_PROVIDER: "openai-compat",
      LLM_API_KEY: "fictional-key",
      LLM_BASE_URL: "https://llm.invalid/v1/",
      LLM_MODEL: "fictional-model",
    });
    expect(config.enableWhatsAppAutoCalls).toBe(true);
  });

  it("treats blank optional integration secrets as unset", () => {
    const config = loadConfig({
      LLM_API_KEY: "",
      LIVEKIT_API_SECRET: "",
      WHATSAPP_ACCESS_TOKEN: "",
      WHATSAPP_PHONE_NUMBER_ID: "",
      WHATSAPP_WABA_ID: "",
    });
    expect(config.secrets.llmApiKey).toBeUndefined();
    expect(config.secrets.livekitApiSecret).toBeUndefined();
    expect(config.secrets.whatsappAccessToken).toBeUndefined();
    expect(config.whatsApp.phoneNumberId).toBeUndefined();
    expect(config.whatsApp.wabaId).toBeUndefined();
  });
});
