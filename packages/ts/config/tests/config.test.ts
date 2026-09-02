import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  configDiagnostics,
  loadConfig,
} from "../src/index.js";

describe("loadConfig", () => {
  it("defaults every real-provider action to disabled", () => {
    const config = loadConfig({});

    expect(config.enableRealTelephony).toBe(false);
    expect(config.enableRealWhatsApp).toBe(false);
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
      AI_API_KEY: "ai-secret",
      AUTH_TOKEN_PEPPER: "auth-token-pepper-with-thirty-two-characters",
      AUTH_SERVICE_SECRET: "auth-service-secret-with-thirty-two-characters",
      AUTH_DUMMY_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=1$dummy$dummy",
    });

    const rendered = JSON.stringify(configDiagnostics(config));
    expect(rendered).not.toContain("do-not-print");
    expect(rendered).not.toContain("also-do-not-print");
    expect(rendered).not.toContain("livekit-secret");
    expect(rendered).not.toContain("whatsapp-secret");
    expect(rendered).not.toContain("ai-secret");
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

  it("treats blank optional integration secrets as unset", () => {
    const config = loadConfig({
      AI_API_KEY: "",
      LIVEKIT_API_SECRET: "",
      WHATSAPP_ACCESS_TOKEN: "",
    });
    expect(config.secrets.aiApiKey).toBeUndefined();
    expect(config.secrets.livekitApiSecret).toBeUndefined();
    expect(config.secrets.whatsappAccessToken).toBeUndefined();
  });
});
