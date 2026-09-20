import { renderMarkup as renderToStaticMarkup } from "./localized";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enabled = vi.hoisted(() => ({
  features: [
    "contacts",
    "leads",
    "tickets",
    "whatsapp",
    "voice",
    "agents",
    "pipeline",
  ],
}));

vi.mock("../src/features/auth", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  withCurrentTenant: (
    _permission: string,
    operation: (sql: object, session: object) => Promise<unknown>,
  ) =>
    operation(
      {},
      {
        isSuperuser: false,
        tenant: { tenantName: "Aurora Operations", role: "owner" },
      },
    ),
}));
vi.mock("@or-on/crm", () => ({
  getTenantFeatureSnapshot: () =>
    Promise.resolve(
      Object.fromEntries(
        [
          "contacts",
          "leads",
          "tickets",
          "whatsapp",
          "voice",
          "agents",
          "pipeline",
          "field_service",
        ].map((key) => [
          key,
          { key, effective: enabled.features.includes(key) },
        ]),
      ),
    ),
  countLeads: () => Promise.resolve({ total: 5 }),
  dashboardMetrics: () =>
    Promise.resolve({
      contacts: 23,
      messagesToday: 4,
      openConversations: 7,
      openPipelineValue: "0",
      openPipelineValues: [],
      unreadMessages: 3,
    }),
  overviewMetrics: () =>
    Promise.resolve({ contacts: 23, openConversations: 7, pendingHandoffs: 2 }),
  listConversations: () => Promise.resolve([]),
  overviewInsights: () =>
    Promise.resolve({ dailyMessages: [], conversationStates: [] }),
  tenantOperationalInsights: () =>
    Promise.resolve({
      monthStart: "2026-09-01",
      checkedAt: "2026-09-10T12:00:00Z",
      inbound: 20,
      outbound: 10,
      delivered: 8,
      failed: 1,
      awaiting: 1,
      contactsReached: 4,
      voiceSessions: 3,
      voiceActive: 0,
      voiceFailed: 1,
      callSeconds: 120,
      agentEvents: 5,
      agentTokens: 900,
      flowRuns: 4,
      flowSucceeded: 3,
      flowFailed: 1,
      flowActive: 0,
    }),
}));
vi.mock("@or-on/config", () => ({
  loadConfig: () => ({ enableRealWhatsApp: false }),
}));

import OverviewPage from "../src/app/page";
import { directionForLocale } from "../src/i18n/direction";

describe("unified web shell", () => {
  beforeEach(() => {
    enabled.features = [
      "contacts",
      "leads",
      "tickets",
      "whatsapp",
      "voice",
      "agents",
      "pipeline",
    ];
  });
  it("renders scoped operational metrics without claiming provider health", async () => {
    const markup = renderToStaticMarkup(await OverviewPage());
    expect(markup).toContain("Workspace overview");
    expect(markup).toContain("Last 14 days · UTC");
    expect(markup).toContain("23");
    expect(markup).toContain("Pending handoffs");
    expect(markup).not.toContain("Simulator");
    expect(markup).not.toContain("Latest conversations");
    expect(markup).toContain("Activity across your workspace");
    expect(markup).toContain("88.9%");
    expect(markup).toContain("Awaiting confirmation");
    expect(markup.match(/class="overview-metric-card"/g)).toHaveLength(4);
    expect(markup).not.toContain("overview-command-deck");
    expect(markup).not.toContain("Real WhatsApp enabled");
    expect(markup).not.toContain("Foundation active");
  });

  it("provides an explicit Hebrew RTL direction strategy", () => {
    expect(directionForLocale("he")).toBe("rtl");
    expect(directionForLocale("en")).toBe("ltr");
  });

  it("tailors a leads-only dashboard without unavailable channels or ticket actions", async () => {
    enabled.features = ["contacts", "leads"];
    const markup = renderToStaticMarkup(await OverviewPage());
    expect(markup).toContain("5 leads in your workspace");
    expect(markup).toContain('href="/leads"');
    for (const destination of [
      "/inbox",
      "/operations",
      "/voice",
      "/tickets",
      "/field-service",
      "/orchestration?tab=agents",
    ])
      expect(markup).not.toContain(`href="${destination}"`);
    expect(markup).not.toContain("Last 14 days · UTC");
    expect(markup).not.toContain("Needs attention");
    expect(markup).not.toContain("No unread messages");
  });
});
