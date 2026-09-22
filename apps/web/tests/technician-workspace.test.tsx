// @vitest-environment jsdom
import "./dialog-test-support";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FieldServiceFeatureState,
  TechnicianSessionContext,
} from "@or-on/crm";

import { FieldServiceWorkspace } from "../src/features/field-service";
import { localized } from "./localized";

const state = vi.hoisted(() => ({
  crmMutation: vi.fn(),
  crmRead: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push, refresh: state.refresh }),
}));
vi.mock("../src/features/crm", () => ({
  crmMutation: state.crmMutation,
  crmRead: state.crmRead,
  csrfToken: () => "test-csrf",
}));

const feature: FieldServiceFeatureState = {
  key: "field_service",
  available: true,
  enabled: true,
  effective: true,
  whatsAppIntakeEnabled: false,
  aiSchedulingEnabled: false,
  ocrEnabled: false,
  sharedTechnicianLoginEnabled: true,
  aiScheduleRequiresApproval: true,
  calendarAccess: "none",
  calendarProvider: null,
  changedByUserId: null,
  changedByDisplayName: null,
  changedAt: null,
  readiness: {
    manualScheduling: true,
    whatsAppChannel: false,
    whatsAppAgent: false,
    calendarCanSuggest: false,
    calendarCanBook: false,
  },
};

const david = {
  id: "60000000-0000-4000-8000-000000000001",
  fullName: "David Fixture",
  identityVerification: "verified" as const,
};
const candidates = [
  { ...david, requiresEmployeeIdentifier: true },
  {
    id: "60000000-0000-4000-8000-000000000002",
    fullName: "Sarah Fixture",
    identityVerification: "self_declared" as const,
    requiresEmployeeIdentifier: false,
  },
];
const contact = {
  id: "70000000-0000-4000-8000-000000000001",
  name: "Fictional customer",
  company: null,
  email: null,
  lifecycleStatus: "active" as const,
  voiceConsent: "granted" as const,
  whatsAppConsent: "granted" as const,
  whatsAppOptedOutAt: null,
  lastActivityAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  identities: [],
  tags: [],
};

function workspace(
  technicianSession: TechnicianSessionContext | undefined,
  options: { readonly isTechnician?: boolean } = {},
) {
  return localized(
    <FieldServiceWorkspace
      appointments={[]}
      canManage={false}
      canOperate
      cases={[]}
      contacts={[contact]}
      feature={feature}
      isTechnician={options.isTechnician ?? true}
      technicianCandidates={candidates}
      technicians={[]}
      timezone="Asia/Jerusalem"
      {...(technicianSession === undefined ? {} : { technicianSession })}
    />,
  );
}

describe("technician Field Service application", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.crmRead.mockImplementation((url: string) =>
      url.startsWith("/api/field-service/queue")
        ? Promise.resolve({
            items: [],
            policy: { selfAssignmentEnabled: true },
          })
        : Promise.resolve({ contacts: [contact] }),
    );
  });
  afterEach(cleanup);

  it("asks an unidentified shared device who is working before showing field work", async () => {
    state.crmMutation.mockResolvedValue({ technician: david });
    render(workspace({ mode: "shared", technician: null }));

    expect(
      screen.getByRole("heading", { name: "Who is working on this device?" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "New service case" }),
    ).toBeNull();
    expect(screen.queryByRole("tab", { name: "My work" })).toBeNull();
    // The employee ID confirms the person; it is never displayed.
    expect(screen.queryByText("FS-DAVID")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /David Fixture/u }));
    const employeeId = screen.getByLabelText("Employee ID");
    fireEvent.change(employeeId, { target: { value: "FS-DAVID" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Start working as David Fixture" }),
    );

    await waitFor(() =>
      expect(state.crmMutation).toHaveBeenCalledWith(
        "/api/field-service/session-technician",
        { technicianId: david.id, employeeIdentifier: "FS-DAVID" },
      ),
    );
    expect(state.refresh).toHaveBeenCalled();
  });

  it("confirms a profile without an employee ID as self-declared", async () => {
    state.crmMutation.mockResolvedValue({ technician: candidates[1] });
    render(workspace({ mode: "shared", technician: null }));

    fireEvent.click(screen.getByRole("radio", { name: /Sarah Fixture/u }));
    expect(screen.queryByLabelText("Employee ID")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Start working as Sarah Fixture" }),
    );

    await waitFor(() =>
      expect(state.crmMutation).toHaveBeenCalledWith(
        "/api/field-service/session-technician",
        { technicianId: candidates[1]?.id },
      ),
    );
  });

  it("creates a case for the identified technician and opens it", async () => {
    const caseId = "80000000-0000-4000-8000-000000000001";
    state.crmMutation.mockResolvedValue({
      case: { id: caseId },
      technicianId: david.id,
      visitId: "90000000-0000-4000-8000-000000000001",
    });
    render(workspace({ mode: "shared", technician: david }));

    expect(screen.getByText("Working as")).toBeTruthy();
    expect(screen.getByText("David Fixture")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New service case" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(
      dialog.getByText(
        "The case is assigned to you (David Fixture) with a first visit ready.",
      ),
    ).toBeTruthy();

    fireEvent.click(dialog.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(state.crmRead).toHaveBeenCalledWith(
        expect.stringContaining("/api/field-service/customers?"),
      ),
    );

    fireEvent.change(dialog.getByLabelText("Customer"), {
      target: { value: contact.id },
    });
    fireEvent.change(dialog.getByLabelText("Case title"), {
      target: { value: "Checkout printer is blank" },
    });
    fireEvent.change(dialog.getByLabelText("Fault description"), {
      target: { value: "Receipts print blank" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Create case" }));

    await waitFor(() =>
      expect(state.crmMutation).toHaveBeenCalledWith(
        "/api/field-service/cases",
        expect.objectContaining({
          customerContactId: contact.id,
          title: "Checkout printer is blank",
          faultDescription: "Receipts print blank",
        }),
      ),
    );
    const created = state.crmMutation.mock.calls.at(-1)?.[1] as
      Record<string, unknown> | undefined;
    expect(created).not.toHaveProperty("technicianId");
    await waitFor(() =>
      expect(state.push).toHaveBeenCalledWith(`/field-service/cases/${caseId}`),
    );
  });

  it("hands the device over by releasing this session's technician", async () => {
    state.crmMutation.mockResolvedValue({ released: true });
    render(workspace({ mode: "shared", technician: david }));

    fireEvent.click(screen.getByRole("button", { name: "Switch technician" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Switch technician" }).at(-1) ??
        document.body,
    );

    await waitFor(() =>
      expect(state.crmMutation).toHaveBeenCalledWith(
        "/api/field-service/session-technician",
        {},
        { method: "DELETE" },
      ),
    );
    expect(state.refresh).toHaveBeenCalled();
  });

  it("explains an account with neither a linked profile nor shared login", () => {
    render(workspace({ mode: "unlinked", technician: null }));
    expect(
      screen.getByRole("heading", {
        name: "This account is not linked to a technician",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "New service case" }),
    ).toBeNull();
  });

  it("keeps an individually linked technician working without identification", () => {
    render(workspace({ mode: "individual", technician: david }));
    expect(
      screen.getByRole("button", { name: "New service case" }),
    ).toBeTruthy();
    expect(screen.getByText("Working as")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Switch technician" }),
    ).toBeNull();
  });

  it("leaves manager case creation and customer search unchanged", async () => {
    render(workspace(undefined, { isTechnician: false }));

    expect(screen.queryByText("Working as")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New service case" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Search",
      }),
    );
    await waitFor(() =>
      expect(state.crmRead).toHaveBeenCalledWith(
        expect.stringContaining("/api/crm/contacts?"),
      ),
    );
  });
});
