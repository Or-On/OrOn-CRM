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
    });

    const rendered = JSON.stringify(configDiagnostics(config));
    expect(rendered).not.toContain("do-not-print");
    expect(rendered).not.toContain("livekit-secret");
    expect(rendered).not.toContain("whatsapp-secret");
    expect(rendered).not.toContain("ai-secret");
    expect(rendered).toContain("[REDACTED]");
  });
});
