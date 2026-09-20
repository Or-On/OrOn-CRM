// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const locale = vi.hoisted(() => ({ value: "en" }));
vi.mock("next-intl", () => ({ useLocale: () => locale.value }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../src/features/crm", () => ({ crmMutation: vi.fn() }));

import {
  tenantFeatureKeys,
  tenantFeatureRegistry,
  tenantTemplateRegistry,
  type TenantFeatureSnapshot,
  type TenantConfigurationState,
  configurationFromTemplate,
} from "@or-on/crm";
import { BusinessConfiguration } from "../src/features/business-configuration";
import { crmMutation } from "../src/features/crm";

afterEach(cleanup);

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

  function state(
    status: "draft" | "submitted" = "draft",
    canApprove = false,
  ): TenantConfigurationState {
    const configuration = configurationFromTemplate("leads_only");
    return {
      active: null,
      initialConfiguration: configuration,
      canApprove,
      history: [],
      draft: {
        id: "release-1",
        version: 1,
        revision: 3,
        status,
        configuration,
        createdAt: "2026-09-20T00:00:00Z",
        submittedAt: status === "submitted" ? "2026-09-20T00:00:00Z" : null,
        approvedAt: null,
        approvedByUserId: null,
        reviewNotes: null,
      },
    };
  }
  function workspace(governance = state()) {
    return (
      <BusinessConfiguration
        definitions={tenantFeatureRegistry}
        initialFeatures={snapshot}
        initialProcesses={[]}
        initialGovernance={governance}
        options={{ agents: [], flows: [] }}
        templates={tenantTemplateRegistry}
      />
    );
  }

  it("keeps feature choices in the draft until explicit save and approval", async () => {
    const saved = state();
    vi.mocked(crmMutation).mockResolvedValue({ configuration: saved });
    render(workspace());
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable Tickets" }));
    expect(crmMutation).not.toHaveBeenCalled();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(crmMutation).toHaveBeenCalledTimes(1));
    const savedCall = vi.mocked(crmMutation).mock.calls[0];
    expect(savedCall?.[0]).toBe("/api/settings/business/configuration");
    expect(savedCall?.[1].expectedRevision).toBe(3);
    const configuration = savedCall?.[1].configuration;
    if (
      !configuration ||
      typeof configuration !== "object" ||
      !("features" in configuration)
    )
      throw new Error("Missing saved configuration");
    expect(configuration.features).toEqual(
      expect.arrayContaining(["contacts", "leads", "tickets"]),
    );
    expect(savedCall[2]).toEqual({ method: "PUT" });
    expect(
      screen.queryByRole("button", { name: "Approve & publish" }),
    ).toBeNull();
  });

  it("saves edits before submitting the saved revision for approval", async () => {
    const saved = state();
    const submitted = state("submitted");
    vi.mocked(crmMutation)
      .mockResolvedValueOnce({ configuration: saved })
      .mockResolvedValueOnce({ configuration: submitted });
    render(workspace());
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable Tickets" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Submit for approval" }),
    );
    await waitFor(() => expect(crmMutation).toHaveBeenCalledTimes(2));
    expect(vi.mocked(crmMutation).mock.calls[0]?.[2]).toEqual({
      method: "PUT",
    });
    expect(vi.mocked(crmMutation).mock.calls[1]?.[1]).toEqual({
      action: "submit",
      expectedRevision: 3,
      note: undefined,
    });
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLInputElement>("checkbox", {
          name: "Enable Leads",
        }).disabled,
      ).toBe(true),
    );
  });

  it("shows publication only to the platform reviewer and requires a rejection note", () => {
    render(workspace(state("submitted", true)));
    expect(
      screen.getByRole("button", { name: "Approve & publish" }),
    ).toBeTruthy();
    const reject = screen.getByRole<HTMLButtonElement>("button", {
      name: "Return for changes",
    });
    expect(reject.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Review notes"), {
      target: { value: "Verify the store directory before activation." },
    });
    expect(reject.disabled).toBe(false);
  });

  it("loads the reusable service template with retail intake and technician policy", () => {
    render(workspace());
    const card = screen
      .getByRole("heading", { name: "Field Service" })
      .closest("article");
    if (!card) throw new Error("Missing service template card");
    fireEvent.click(within(card).getByRole("button", { name: "Use template" }));
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Chain" }).checked,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "Store / branch",
      }).checked,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "Identity number",
      }).checked,
    ).toBe(false);
    expect(
      screen.getByLabelText<HTMLSelectElement>("Photos during intake").value,
    ).toBe("requested");
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "Allow eligible technicians to take available incidents",
      }).checked,
    ).toBe(true);
    expect(crmMutation).not.toHaveBeenCalled();
  });

  it("explains unavailable platform access before allowing publication", () => {
    const submitted = state("submitted", true);
    if (!submitted.draft) throw new Error("Missing submitted fixture");
    render(
      <BusinessConfiguration
        definitions={tenantFeatureRegistry}
        initialFeatures={{
          ...snapshot,
          field_service: { ...snapshot.field_service, available: false },
        }}
        initialProcesses={[]}
        initialGovernance={{
          ...submitted,
          draft: {
            ...submitted.draft,
            configuration: configurationFromTemplate("field_service"),
          },
        }}
        options={{ agents: [], flows: [] }}
        templates={tenantTemplateRegistry}
      />,
    );
    expect(screen.getByText("Platform access required")).toBeTruthy();
    expect(
      screen.getByText(/selecting a template does not grant module access/),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Approve & publish",
      }).disabled,
    ).toBe(true);
  });
});
