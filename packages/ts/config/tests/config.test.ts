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

  it("redacts connection strings and provider secrets from diagnostics", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://platform:do-not-print@localhost/platform",
      LIVEKIT_API_SECRET: "livekit-secret",
      WHATSAPP_ACCESS_TOKEN: "whatsapp-secret",
      AI_API_KEY: "ai-secret",
      AUTH_TOKEN_PEPPER: "auth-token-pepper-with-thirty-two-characters",
      AUTH_SERVICE_SECRET: "auth-service-secret-with-thirty-two-characters",
      AUTH_DUMMY_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=1$dummy$dummy",
    });

    const rendered = JSON.stringify(configDiagnostics(config));
    expect(rendered).not.toContain("do-not-print");
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
