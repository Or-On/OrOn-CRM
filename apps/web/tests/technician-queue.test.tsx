// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TechnicianQueue } from "../src/features/field-service";
import { localized } from "./localized";

const state = vi.hoisted(() => ({
  read: vi.fn(),
  mutation: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../src/features/crm", () => ({
  crmRead: state.read,
  crmMutation: state.mutation,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push, refresh: state.refresh }),
}));
afterEach(cleanup);
const item = {
  id: "case-1",
  reference: "FS-2026-123",
  title: "Checkout does not print",
  faultDescription: "Receipts are blank",
  status: "awaiting_scheduling",
  priority: "high",
  customerName: "Store manager",
  storeName: "North branch",
  chainName: "Retail group",
  assignedTechnicianId: null,
  assignedTechnicianName: null,
  updatedAt: "2026-09-20T12:00:00Z",
};
describe("technician self-assignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.read.mockResolvedValue({
      items: [item],
      policy: { selfAssignmentEnabled: true },
    });
    state.mutation.mockResolvedValue({
      caseId: item.id,
      technicianId: "technician-1",
      visitId: "visit-1",
    });
  });
  it("starts with my incidents and claims an available incident before opening its dossier", async () => {
    render(localized(<TechnicianQueue canClaim />));
    await screen.findByText(item.title);
    expect(state.read).toHaveBeenCalledWith(
      "/api/field-service/queue?view=mine",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Available incidents" }),
    );
    const claim = await screen.findByRole("button", {
      name: "Take this incident",
    });
    expect(screen.getByText("Retail group · North branch")).toBeTruthy();
    fireEvent.click(claim);
    await waitFor(() =>
      expect(state.mutation).toHaveBeenCalledWith(
        "/api/field-service/cases/case-1/claim",
        {},
        { method: "POST" },
      ),
    );
    await waitFor(() =>
      expect(state.push).toHaveBeenCalledWith("/field-service/cases/case-1"),
    );
  });
  it("keeps a claim conflict visible and refreshes the available queue", async () => {
    state.mutation.mockRejectedValue(
      new Error("Another technician already took this incident."),
    );
    render(localized(<TechnicianQueue canClaim />));
    fireEvent.click(
      screen.getByRole("button", { name: "Available incidents" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Take this incident" }),
    );
    expect(
      await screen.findByText("Another technician already took this incident."),
    ).toBeTruthy();
    expect(state.push).not.toHaveBeenCalled();
  });
  it("respects manager-only assignment and supports Hebrew RTL", async () => {
    state.read.mockResolvedValue({
      items: [item],
      policy: { selfAssignmentEnabled: false },
    });
    const { container } = render(localized(<TechnicianQueue canClaim />, "he"));
    fireEvent.click(screen.getByRole("button", { name: "זמינים לטיפול" }));
    expect(await screen.findByText("ממתין לשיוך מנהל")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "לקחת לטיפולי" })).toBeNull();
    expect(container.querySelector('[dir="rtl"]')).toBeTruthy();
  });
});
