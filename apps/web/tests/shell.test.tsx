import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/features/auth/server", () => ({
  currentPublicSession: () =>
    Promise.resolve({
      expiresAt: "2030-01-01T00:00:00Z",
      memberships: [],
      permissions: ["platform:read"],
      tenant: {
        role: "owner",
        tenantId: "10000000-0000-4000-8000-000000000001",
        tenantName: "Aurora Operations",
        tenantSlug: "aurora-operations",
      },
      user: {
        id: "20000000-0000-4000-8000-000000000001",
        email: "operator@example.test",
      },
    }),
}));

import FoundationPage from "../src/app/page";
import { directionForLocale } from "../src/i18n/direction";

describe("unified web shell", () => {
  it("renders the authenticated foundation without claiming feature parity", async () => {
    const markup = renderToStaticMarkup(await FoundationPage());
    expect(markup).toContain("One identity. Tenant-safe operations.");
    expect(markup).toContain("Foundation active");
  });

  it("provides an explicit Hebrew RTL direction strategy", () => {
    expect(directionForLocale("he")).toBe("rtl");
    expect(directionForLocale("en")).toBe("ltr");
  });
});
