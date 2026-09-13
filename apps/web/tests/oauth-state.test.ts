import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSession, TenantTransaction } from "@or-on/auth";
import {
  consumeOAuthState,
  oauthCallbackUrl,
  sameOAuthIdentity,
} from "../src/features/email";

const identity = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000001",
  tenant: { tenantId: "30000000-0000-4000-8000-000000000001" },
} as AuthSession;

afterEach(() => vi.unstubAllEnvs());

describe("OAuth authorization binding", () => {
  it("uses only the configured production origin, not an attacker-controlled Host", () => {
    vi.stubEnv("PLATFORM_ENV", "production");
    vi.stubEnv("PUBLIC_SITE_URL", "https://app.example.invalid");
    expect(oauthCallbackUrl("google", "https://evil.invalid/start")).toBe(
      "https://app.example.invalid/api/email/oauth/google/callback",
    );
  });
  it("requires a production callback origin and rejects insecure non-local origins", () => {
    vi.stubEnv("PLATFORM_ENV", "production");
    vi.stubEnv("PUBLIC_SITE_URL", "");
    expect(() => oauthCallbackUrl("google", "https://evil.invalid")).toThrow();
    vi.stubEnv("PUBLIC_SITE_URL", "http://app.example.invalid");
    expect(() =>
      oauthCallbackUrl("google", "http://app.example.invalid"),
    ).toThrow();
  });
  it.each(["sessionId", "userId", "tenant"] as const)(
    "rejects changed %s after provider exchange",
    (field) => {
      const changed =
        field === "tenant"
          ? {
              ...identity,
              tenant: { ...identity.tenant, tenantId: "different" },
            }
          : { ...identity, [field]: "different" };
      expect(() => sameOAuthIdentity(identity, changed)).toThrow(
        "identity changed",
      );
      expect(() => sameOAuthIdentity(identity, identity)).not.toThrow();
    },
  );
  it("rejects non-HTTP schemes even on loopback", () => {
    vi.stubEnv("PUBLIC_SITE_URL", "ftp://localhost");
    expect(() => oauthCallbackUrl("google", "http://localhost")).toThrow();
  });
  it("refuses expired/replayed state before any external exchange", async () => {
    const sql = vi.fn().mockResolvedValue([]);
    await expect(
      consumeOAuthState(
        sql as unknown as TenantTransaction,
        identity,
        "a".repeat(43),
        "google",
        "https://app.example.invalid/callback",
      ),
    ).rejects.toThrow("already used");
    expect(sql.mock.calls[0]?.slice(1)).toContain(identity.sessionId);
    expect(sql.mock.calls[0]?.slice(1)).not.toContain("a".repeat(43));
  });
});
