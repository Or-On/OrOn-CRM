// @vitest-environment jsdom
import "./dialog-test-support";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContactSummary, PipelineBoard } from "@or-on/crm";

import { ContactManager } from "../src/features/contacts";
import { PipelineBoard as PipelineWorkspace } from "../src/features/pipelines";
import { localized } from "./localized";

const transport = vi.hoisted(() => ({
  mutate: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: transport.refresh, push: transport.push }),
}));
vi.mock("../src/features/crm", () => ({ crmMutation: transport.mutate }));

const contacts: readonly ContactSummary[] = [
  {
    id: "contact-active",
    name: "Maya Cohen",
    email: "maya@example.invalid",
    company: "Northwind Fictional",
    lifecycleStatus: "active",
    voiceConsent: "unknown",
    whatsAppConsent: "granted",
    whatsAppOptedOutAt: null,
    lastActivityAt: "2026-09-01T10:00:00Z",
    createdAt: "2026-08-01T10:00:00Z",
    identities: [
      {
        id: "identity-whatsapp",
        channel: "whatsapp",
        normalizedValue: "+14155550101",
        displayValue: null,
        validationStatus: "valid",
        isPrimary: true,
      },
    ],
    tags: [{ id: "tag-priority", name: "Priority", color: "#3b82f6" }],
  },
  {
    id: "contact-blocked",
    name: "Noam Levi",
    email: "noam@example.invalid",
    company: "Contoso Fictional",
    lifecycleStatus: "blocked",
    voiceConsent: "revoked",
    whatsAppConsent: "revoked",
    whatsAppOptedOutAt: "2026-08-20T10:00:00Z",
    lastActivityAt: null,
    createdAt: "2026-08-02T10:00:00Z",
    identities: [
      {
        id: "identity-email",
        channel: "email",
        normalizedValue: "noam@example.invalid",
        displayValue: null,
        validationStatus: "valid",
        isPrimary: true,
      },
    ],
    tags: [],
  },
];

const pipeline: PipelineBoard = {
  id: "pipeline-main",
  name: "Fictional sales",
  stages: [
    {
      id: "stage-new",
      pipelineId: "pipeline-main",
      name: "New",
      position: 0,
      probability: 10,
    },
    {
      id: "stage-qualified",
      pipelineId: "pipeline-main",
      name: "Qualified",
      position: 1,
      probability: 50,
    },
  ],
  deals: [
    {
      id: "deal-1",
      pipelineId: "pipeline-main",
      stageId: "stage-new",
      contactId: "contact-active",
      contactName: "Maya Cohen",
      title: "Fictional renewal",
      value: "9007199254740993.03",
      currency: "USD",
      status: "open",
      updatedAt: "2026-09-01T10:00:00Z",
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("contact index workspace", () => {
  it("sorts stably, pages only loaded rows, and resets pagination for a tag filter", () => {
    const first = contacts[0];
    if (!first) throw new Error("Contact fixture missing");
    const loaded = Array.from({ length: 30 }, (_, index) => ({
      ...first,
      id: `contact-${String(index)}`,
      name: `Fictional ${String(index).padStart(2, "0")}`,
      tags: index === 0 ? first.tags : [],
    }));
    render(localized(<ContactManager contacts={loaded} />));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), {
      target: { value: "nameAsc" },
    });
    const table = () => within(screen.getByRole("table"));
    expect(table().getAllByRole("row")).toHaveLength(26);
    expect(table().getAllByRole("link")[0]?.textContent).toBe("Fictional 00");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(table().getAllByRole("row")).toHaveLength(6);
    expect(table().getAllByRole("link")[0]?.textContent).toBe("Fictional 25");
    fireEvent.change(screen.getByRole("combobox", { name: "Tag" }), {
      target: { value: "tag-priority" },
    });
    expect(table().getAllByRole("link")).toHaveLength(1);
    expect(table().getAllByRole("link")[0]?.textContent).toBe("Fictional 00");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(loaded[0]?.name).toBe("Fictional 00");
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it("submits directory searches to the existing route without mutating contacts", () => {
    render(localized(<ContactManager contacts={contacts} />));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search contacts" }),
      {
        target: { value: "Maya & team" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Search directory" }));
    expect(transport.push).toHaveBeenCalledWith(
      "/contacts?q=Maya%20%26%20team",
    );
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it("scopes directory summaries to filtered loaded records and preserves a closed creation draft", () => {
    const view = render(localized(<ContactManager contacts={contacts} />));
    expect(screen.getByText(/Latest 2 matching contacts/)).toBeTruthy();
    expect(screen.queryByText(/consent/i)).toBeNull();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search contacts" }),
      { target: { value: "Maya" } },
    );
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(
      2,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
    const name = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Name",
    });
    fireEvent.change(name, { target: { value: "Fictional retained contact" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
    expect(
      view.container.querySelector<HTMLInputElement>("#contact-name")?.value,
    ).toBe("Fictional retained contact");
    expect(transport.mutate).not.toHaveBeenCalled();
  });
  it("synchronizes route-backed search and creation intent after client navigation", () => {
    const view = render(
      localized(
        <ContactManager
          contacts={contacts}
          initialPanel="create"
          query="Maya"
        />,
      ),
    );

    expect(
      screen.getByRole<HTMLInputElement>("searchbox", {
        name: "Search contacts",
      }).value,
    ).toBe("Maya");
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();

    view.rerender(
      localized(<ContactManager contacts={contacts} query="Noam" />),
    );
    expect(
      screen.getByRole<HTMLInputElement>("searchbox", {
        name: "Search contacts",
      }).value,
    ).toBe("Noam");
    expect(screen.getAllByText("Noam Levi")[0]).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  });

  it("renders a dense accessible table and filters loaded rows without mutating data", () => {
    render(localized(<ContactManager contacts={contacts} />));

    expect(screen.getByRole("table", { name: "Contacts" })).toBeTruthy();
    expect(
      within(screen.getByRole("table"))
        .getByRole("link", { name: "Open contact: Maya Cohen" })
        .getAttribute("href"),
    ).toBe("/contacts/contact-active");

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search contacts" }),
      {
        target: { value: "Contoso" },
      },
    );
    expect(screen.queryByText("Maya Cohen")).toBeNull();
    expect(screen.getAllByText("Noam Levi")[0]).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "active" },
    });
    expect(screen.getAllByText("Maya Cohen")[0]).toBeTruthy();
    expect(screen.queryByText("Noam Levi")).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Channel" }), {
      target: { value: "email" },
    });
    expect(screen.queryByText("Maya Cohen")).toBeNull();
    expect(screen.getAllByText("Noam Levi")[0]).toBeTruthy();
  });
});

describe("pipeline Kanban workspace", () => {
  it("keeps open value exact and excludes won opportunities without excluding their cards", () => {
    const existing = pipeline.deals[0];
    if (!existing) throw new Error("Pipeline fixture requires an opportunity");
    render(
      localized(
        <PipelineWorkspace
          boards={[
            {
              ...pipeline,
              deals: [
                ...pipeline.deals,
                {
                  ...existing,
                  id: "won",
                  status: "won",
                  title: "Fictional won",
                  value: "500.00",
                },
              ],
            },
          ]}
        />,
      ),
    );
    const totals = screen.getByLabelText("Open opportunity value");
    expect(totals.textContent).toContain("9,007,199,254,740,993.03");
    expect(totals.textContent).not.toContain("500.00");
    expect(screen.getByText("Fictional won")).toBeTruthy();
  });
  it("derives stage distribution from actual deals and updates it with optimistic movement", async () => {
    transport.mutate.mockResolvedValueOnce({});
    render(localized(<PipelineWorkspace boards={[pipeline]} />));
    const distribution = screen.getByRole("navigation", {
      name: "Opportunities by stage",
    });
    const newMeter = within(distribution).getByRole<HTMLMeterElement>("meter", {
      name: "New",
    });
    const qualifiedMeter = within(distribution).getByRole<HTMLMeterElement>(
      "meter",
      { name: "Qualified" },
    );
    expect(newMeter.value).toBe(1);
    expect(qualifiedMeter.value).toBe(0);
    expect(
      within(distribution)
        .getByRole("link", { name: /Qualified/u })
        .getAttribute("href"),
    ).toBe("#pipeline-stage-stage-qualified");

    fireEvent.change(screen.getByRole("combobox", { name: "Move stage" }), {
      target: { value: "stage-qualified" },
    });
    expect(newMeter.value).toBe(0);
    expect(qualifiedMeter.value).toBe(1);
    await vi.waitFor(() => expect(transport.refresh).toHaveBeenCalled());
  });

  it("supports an optimistic pointer drag between valid stages", async () => {
    transport.mutate.mockResolvedValueOnce({});
    render(localized(<PipelineWorkspace boards={[pipeline]} />));

    const card = screen.getByText("Fictional renewal").closest("article");
    const qualifiedStage = screen
      .getByRole("heading", { name: "Qualified" })
      .closest("section");
    if (!card || !qualifiedStage) throw new Error("Pipeline fixture missing");
    const transfer = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (format: string) => transfer.get(format) ?? "",
      setData: (format: string, value: string) => {
        transfer.set(format, value);
      },
    } as unknown as DataTransfer;

    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragEnter(qualifiedStage, { dataTransfer });
    fireEvent.dragOver(qualifiedStage, { dataTransfer });
    fireEvent.drop(qualifiedStage, { dataTransfer });

    expect(within(qualifiedStage).getByText("Fictional renewal")).toBeTruthy();
    await vi.waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        "/api/crm/deals/deal-1/stage",
        { stageId: "stage-qualified" },
      ),
    );
  });

  it("moves a deal optimistically and rolls it back when persistence fails", async () => {
    transport.mutate.mockRejectedValueOnce(new Error("fixture failure"));
    render(localized(<PipelineWorkspace boards={[pipeline]} />));

    const newStage = screen
      .getByRole("heading", { name: "New" })
      .closest("section");
    const qualifiedStage = screen
      .getByRole("heading", { name: "Qualified" })
      .closest("section");
    if (!newStage || !qualifiedStage) throw new Error("Pipeline stage missing");

    expect(within(newStage).getByText("Fictional renewal")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "Move stage" }), {
      target: { value: "stage-qualified" },
    });

    expect(within(qualifiedStage).getByText("Fictional renewal")).toBeTruthy();
    expect(transport.mutate).toHaveBeenCalledWith(
      "/api/crm/deals/deal-1/stage",
      { stageId: "stage-qualified" },
    );
    await screen.findByRole("alert");
    expect(within(newStage).getByText("Fictional renewal")).toBeTruthy();
    expect(within(qualifiedStage).queryByText("Fictional renewal")).toBeNull();
  });

  it("keeps the keyboard stage control disabled for read-only users", () => {
    render(
      localized(<PipelineWorkspace boards={[pipeline]} />, "en", ["crm:read"]),
    );

    expect(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Move stage" })
        .disabled,
    ).toBe(true);
    expect(transport.mutate).not.toHaveBeenCalled();
  });
});
