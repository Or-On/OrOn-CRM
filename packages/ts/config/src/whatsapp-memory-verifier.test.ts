import { describe, expect, it } from "vitest";
import { loadWhatsAppMemoryVerifier } from "./index.js";
describe("webhook-only memory verifier", () => {
  it("default off never exposes proof credential", () => {
    expect(
      loadWhatsAppMemoryVerifier(
        {
          WHATSAPP_MEMORY_VERIFIER_DATABASE_URL:
            "postgres://unused:private@127.0.0.1:55480/fictional",
        },
        "web",
      ),
    ).toEqual({ enabled: false, databaseUrl: undefined });
  });
  it("worker service never receives verifier credential even if ambient env contains it", () => {
    expect(
      loadWhatsAppMemoryVerifier(
        {
          WHATSAPP_MEMORY_SIGNATURE_PROOF_ENABLED: "true",
          WHATSAPP_MEMORY_VERIFIER_DATABASE_URL:
            "postgres://unused:private@127.0.0.1:55480/fictional",
        },
        "messaging-worker",
      ),
    ).toEqual({ enabled: false, databaseUrl: undefined });
  });
  it("enabled without provisioned separate credential stays unavailable", () => {
    expect(
      loadWhatsAppMemoryVerifier(
        { WHATSAPP_MEMORY_SIGNATURE_PROOF_ENABLED: "true" },
        "web",
      ),
    ).toEqual({ enabled: true, databaseUrl: undefined });
  });
  it.each(["yes", "1", ""])("rejects noncanonical flag %s", (flag) => {
    expect(() =>
      loadWhatsAppMemoryVerifier(
        { WHATSAPP_MEMORY_SIGNATURE_PROOF_ENABLED: flag },
        "web",
      ),
    ).toThrow("invalid WhatsApp signature proof flag");
  });
  it("accepts an explicit separately configured PostgreSQL credential only at web boundary", () => {
    const databaseUrl = "postgres://unused:private@127.0.0.1:55480/fictional";
    expect(
      loadWhatsAppMemoryVerifier(
        {
          WHATSAPP_MEMORY_SIGNATURE_PROOF_ENABLED: "true",
          WHATSAPP_MEMORY_VERIFIER_DATABASE_URL: databaseUrl,
        },
        "web",
      ),
    ).toEqual({ enabled: true, databaseUrl });
  });
  it.each(["https://example.invalid/db", "not a URL", "postgres://127.0.0.1/"])(
    "rejects invalid verifier target with content-free error",
    (databaseUrl) => {
      expect(() =>
        loadWhatsAppMemoryVerifier(
          {
            WHATSAPP_MEMORY_SIGNATURE_PROOF_ENABLED: "true",
            WHATSAPP_MEMORY_VERIFIER_DATABASE_URL: databaseUrl,
          },
          "web",
        ),
      ).toThrow("invalid WhatsApp verifier database configuration");
    },
  );
});
