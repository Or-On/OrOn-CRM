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
vi.mock("next-intl", () => ({
  useLocale: () => locale.value,
  useTimeZone: () => "Asia/Jerusalem",
}));
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
    expect(html).toContain("Requires Field Service");
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

  // Sections are tab panels, as on the Settings page; open one before using it.
  function openSection(name: RegExp) {
    fireEvent.click(screen.getByRole("tab", { name }));
  }

  function fieldWorkspace() {
    const base = state();
    if (!base.draft) throw new Error("Missing fixture");
    return workspace({
      ...base,
      draft: {
        ...base.draft,
        configuration: configurationFromTemplate("field_service"),
      },
    });
  }

  it("keeps partial template language editable and rejects invalid policy on save", async () => {
    render(fieldWorkspace());
    openSection(/^Service workflow/);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Send a WhatsApp follow-up/,
      }),
    );
    fireEvent.change(screen.getByLabelText(/Approved template outside/), {
      target: { value: "synthetic_followup" },
    });
    const language = screen.getByLabelText("Template language code");
    fireEvent.change(language, { target: { value: "h" } });
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: "Template language code",
      }).value,
    ).toBe("h");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(
        screen.getByText("Invalid approved WhatsApp template"),
      ).toBeTruthy(),
    );
    expect(crmMutation).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Template language code")).toBeTruthy();
    vi.mocked(crmMutation).mockResolvedValue({ configuration: state() });
    fireEvent.change(language, { target: { value: "he" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(crmMutation).toHaveBeenCalledTimes(1));
    expect(
      vi.mocked(crmMutation).mock.calls[0]?.[1].configuration,
    ).toHaveProperty(
      "featureConfiguration.field_service.workflow.whatsappFollowUp.templateLanguage",
      "he",
    );
  });
  it("describes explicit web-form submission and keeps fault description free text", () => {
    render(fieldWorkspace());
    openSection(/^Service workflow/);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Send a WhatsApp follow-up/ }),
    );
    fireEvent.change(screen.getByLabelText("What the call does"), {
      target: { value: "form" },
    });
    expect(
      screen.getByText(
        /A case opens only after the customer explicitly submits that form/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/name and free-text fault description/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /does not use a template or switch to collecting the form by phone/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Store name" })).toBeNull();
    expect(screen.queryByLabelText(/Approved template outside/)).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "Ask for a photo of the fault" }),
    ).toBeNull();
    expect(
      screen.getByText(
        /Photos are optional unless the photo policy requires them/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("combobox", { name: "Fault description" }),
    ).toBeNull();
  });

  it("keeps new incomplete document rows visible while strict save validation blocks them", async () => {
    render(fieldWorkspace());
    openSection(/^Service workflow/);
    fireEvent.click(screen.getByRole("button", { name: "Add document type" }));
    expect(screen.getByLabelText("Key")).toBeTruthy();
    expect(screen.getByLabelText("Label")).toBeTruthy();
    const key = screen.getByLabelText("Key");
    key.focus();
    fireEvent.change(key, { target: { value: "owned_doc" } });
    expect(screen.getByLabelText("Key")).toBe(key);
    expect(document.activeElement).toBe(key);
    fireEvent.change(key, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(screen.getByText(/Invalid document type key/)).toBeTruthy(),
    );
    expect(crmMutation).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Key")).toBeTruthy();
  });

  it("allows adding and completing a checklist item before strict save validation", async () => {
    render(fieldWorkspace());
    openSection(/^Service workflow/);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Show a preparation checklist/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add checklist item" }));
    const item = screen.getByLabelText("Item");
    expect(item).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(screen.getByText(/Checklist label/)).toBeTruthy(),
    );
    expect(crmMutation).not.toHaveBeenCalled();
    vi.mocked(crmMutation).mockResolvedValue({ configuration: state() });
    fireEvent.change(item, { target: { value: "Bring synthetic tools" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(crmMutation).toHaveBeenCalledTimes(1));
    expect(
      vi.mocked(crmMutation).mock.calls[0]?.[1].configuration,
    ).toHaveProperty(
      "featureConfiguration.field_service.workflow.preparation.checklist.0.label",
      "Bring synthetic tools",
    );
  });

  it("resumes returned contents as a new draft without modifying review history", async () => {
    const base = state();
    if (!base.draft) throw new Error("Missing fixture");
    const returned = {
      ...base.draft,
      status: "rejected" as const,
      version: 2,
      configuration: configurationFromTemplate("field_service"),
      reviewNotes: "Update the workflow",
    };
    const governance = {
      ...base,
      draft: null,
      history: [returned],
      active: null,
    };
    const historyBefore = JSON.stringify(governance.history);
    vi.mocked(crmMutation).mockResolvedValue({ configuration: state() });
    render(workspace(governance));
    openSection(/^Modules/);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "Enable Field Service",
      }).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(crmMutation).toHaveBeenCalledTimes(1));
    expect(vi.mocked(crmMutation).mock.calls[0]?.[1]).toEqual({
      configuration: returned.configuration,
      expectedRevision: null,
    });
    expect(JSON.stringify(governance.history)).toBe(historyBefore);
    expect(
      screen.queryByRole("button", { name: "Approve & publish" }),
    ).toBeNull();
  });

  it("does not resume an older returned release over a newer active configuration", () => {
    const base = state();
    if (!base.draft) throw new Error("Missing fixture");
    render(
      workspace({
        ...base,
        draft: null,
        active: { ...base.draft, status: "published", version: 3 },
        history: [
          {
            ...base.draft,
            status: "rejected",
            version: 2,
            configuration: configurationFromTemplate("field_service"),
          },
        ],
      }),
    );
    openSection(/^Modules/);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "Enable Field Service",
      }).checked,
    ).toBe(false);
    expect(crmMutation).not.toHaveBeenCalled();
  });

  it("keeps feature choices in the draft until explicit save and approval", async () => {
    const saved = state();
    vi.mocked(crmMutation).mockResolvedValue({ configuration: saved });
    render(workspace());
    openSection(/^Modules/);
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
    openSection(/^Modules/);
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
    // The side panel points the reviewer at the review section.
    fireEvent.click(screen.getByRole("button", { name: "Review submission" }));
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

  it("saves the service-manager choice before submitting an existing draft", async () => {
    const saved = state();
    if (!saved.draft) throw new Error("Missing draft fixture");
    const governance = {
      ...saved,
      draft: {
        ...saved.draft,
        configuration: configurationFromTemplate("field_service"),
      },
    };
    vi.mocked(crmMutation)
      .mockResolvedValueOnce({ configuration: governance })
      .mockResolvedValueOnce({ configuration: state("submitted") });
    render(workspace(governance));
    openSection(/^Service workflow/);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Simple service-manager screens" }),
    );
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(crmMutation).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Submit for approval" }),
    );
    await waitFor(() => expect(crmMutation).toHaveBeenCalledTimes(2));
    const submittedConfiguration =
      vi.mocked(crmMutation).mock.calls[0]?.[1].configuration;
    expect(submittedConfiguration).toHaveProperty(
      "featureConfiguration.field_service.experience",
      "service_manager",
    );
    expect(submittedConfiguration).toHaveProperty(
      "featureConfiguration.field_service.workflow",
      governance.draft.configuration.featureConfiguration.field_service
        ?.workflow,
    );
    expect(vi.mocked(crmMutation).mock.calls[0]?.[2]).toEqual({
      method: "PUT",
    });
    expect(vi.mocked(crmMutation).mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ action: "submit" }),
    );
  });

  it("loads the reusable service template with retail intake and technician policy", () => {
    render(workspace());
    // The Field Service template card, not the Field Service module card.
    const card = screen
      .getAllByRole("heading", { name: "Field Service" })
      .map((heading) => heading.closest("article"))
      .find(
        (article) =>
          article !== null &&
          within(article).queryByRole("button", { name: "Use template" }) !==
            null,
      );
    if (!card) throw new Error("Missing service template card");
    fireEvent.click(within(card).getByRole("button", { name: "Use template" }));
    openSection(/^Service workflow/);
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
    openSection(/^Modules/);
    expect(screen.getByText("Platform access required")).toBeTruthy();
    openSection(/^Review & publish/);
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
