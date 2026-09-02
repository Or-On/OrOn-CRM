import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/features/auth", () => ({
  withCurrentTenant: (
    _permission: string,
    operation: (sql: object, session: object) => Promise<unknown>,
  ) => operation({}, { tenant: { tenantName: "Aurora Operations" } }),
}));
vi.mock("@or-on/crm", () => ({
  overviewMetrics: () =>
    Promise.resolve({ contacts: 23, openConversations: 7, pendingHandoffs: 2 }),
  listConversations: () => Promise.resolve([]),
}));
vi.mock("@or-on/config", () => ({
  loadConfig: () => ({ enableRealWhatsApp: false }),
}));

import OverviewPage from "../src/app/page";
import { directionForLocale } from "../src/i18n/direction";

describe("unified web shell", () => {
  it("renders scoped operational metrics without claiming provider health", async () => {
    const markup = renderToStaticMarkup(await OverviewPage());
    expect(markup).toContain("Your workspace, at a glance.");
    expect(markup).toContain("23");
    expect(markup).toContain("Pending handoffs");
    expect(markup).toContain("Simulator-first workspace");
    expect(markup).not.toContain("Foundation active");
  });

  it("provides an explicit Hebrew RTL direction strategy", () => {
    expect(directionForLocale("he")).toBe("rtl");
    expect(directionForLocale("en")).toBe("ltr");
  });
});
