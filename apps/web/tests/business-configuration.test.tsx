import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const locale = vi.hoisted(() => ({ value: "en" }));
vi.mock("next-intl", () => ({ useLocale: () => locale.value }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../src/features/crm", () => ({ crmMutation: vi.fn() }));

import {
  tenantFeatureKeys,
  tenantFeatureRegistry,
  tenantTemplateRegistry,
  type TenantFeatureSnapshot,
} from "@or-on/crm";
import { BusinessConfiguration } from "../src/features/business-configuration";

const snapshot = Object.fromEntries(
  tenantFeatureKeys.map((key) => [
    key,
    {
      key,
      available: true,
      enabled: ["contacts", "agents", "tickets"].includes(key),
      effective: ["contacts", "agents", "tickets"].includes(key),
      configuration: {},
      configurationSchemaVersion: 1,
      source: "operator",
      revision: 2,
      updatedAt: "2026-09-20T00:00:00.000Z",
      updatedByUserId: null,
    },
  ]),
) as unknown as TenantFeatureSnapshot;

describe("business configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    locale.value = "en";
  });

  it("renders modules, dependencies, templates and explicit process versions", () => {
    const html = renderToStaticMarkup(
      <BusinessConfiguration
        definitions={tenantFeatureRegistry}
        initialFeatures={snapshot}
        initialProcesses={[
          {
            id: "10000000-0000-4000-8000-000000000001",
            name: "Support intake",
            purpose: "Handle support",
            enabled: true,
            trigger: "whatsapp.new_conversation",
            channel: "whatsapp",
            businessObject: "ticket",
            agentProfileVersionId: "20000000-0000-4000-8000-000000000001",
            agentName: "Support agent",
            agentVersion: 4,
            flowVersionId: "30000000-0000-4000-8000-000000000001",
            flowName: "Support flow",
            flowVersion: 2,
            requiredFeatures: ["contacts", "whatsapp", "agents", "tickets"],
            priority: 10,
            revision: 3,
            updatedAt: "2026-09-20T00:00:00.000Z",
          },
        ]}
        options={{ agents: [], flows: [] }}
        templates={tenantTemplateRegistry}
      />,
    );
    expect(html).toContain("Business templates");
    expect(html).toContain("Field Service");
    expect(html).toContain("Requires Field service");
    expect(html).toContain("Support intake");
    expect(html).toContain("Support agent v4");
    expect(html).toContain("Support flow v2");
  });

  it("renders the configuration workspace in Hebrew RTL", () => {
    locale.value = "he";
    const html = renderToStaticMarkup(
      <BusinessConfiguration
        definitions={tenantFeatureRegistry}
        initialFeatures={snapshot}
        initialProcesses={[]}
        options={{ agents: [], flows: [] }}
        templates={tenantTemplateRegistry}
      />,
    );

    expect(html).toContain('dir="rtl"');
    expect(html).toContain("תבניות עסקיות");
    expect(html).toContain("מודולים");
    expect(html).toContain("יצירת תהליך");
  });
});
