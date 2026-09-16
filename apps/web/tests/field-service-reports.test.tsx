// @vitest-environment jsdom
import "./dialog-test-support";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceReportSummary } from "@or-on/crm";

import { ReportsWorkspace } from "../src/features/field-service";
import { localized } from "./localized";

const state = vi.hoisted(() => ({ crmMutation: vi.fn(), crmRead: vi.fn() }));

vi.mock("../src/features/crm", () => ({
  crmMutation: state.crmMutation,
  crmRead: state.crmRead,
}));

const finalizedReport: ServiceReportSummary = {
  id: "10000000-0000-4000-8000-000000000001",
  reportId: "20000000-0000-4000-8000-000000000001",
  version: 2,
  status: "finalized",
  caseId: "30000000-0000-4000-8000-000000000001",
  caseReference: "FS-2026-0021",
  caseTitle: "Synthetic control-board fault",
  customerContactId: "40000000-0000-4000-8000-000000000001",
  customerName: "Fictional Customer",
  visitId: "50000000-0000-4000-8000-000000000001",
  visitNumber: 2,
  technicianId: "60000000-0000-4000-8000-000000000001",
  technicianName: "Fictional Technician",
  finalizedAt: "2026-09-15T11:00:00.000Z",
  createdAt: "2026-09-15T10:00:00.000Z",
  updatedAt: "2026-09-15T11:00:00.000Z",
};

const draftReport: ServiceReportSummary = {
  ...finalizedReport,
  id: "10000000-0000-4000-8000-000000000002",
  reportId: "20000000-0000-4000-8000-000000000002",
  version: 1,
  status: "draft",
  caseId: "30000000-0000-4000-8000-000000000002",
  caseReference: "FS-2026-0022",
  caseTitle: "Synthetic refrigeration fault",
  customerContactId: "40000000-0000-4000-8000-000000000002",
  customerName: "Fictional Customer Two",
  visitId: "50000000-0000-4000-8000-000000000002",
  visitNumber: 1,
  technicianId: "60000000-0000-4000-8000-000000000002",
  technicianName: "Fictional Technician Two",
  finalizedAt: null,
  createdAt: "2026-09-14T10:00:00.000Z",
  updatedAt: "2026-09-14T10:00:00.000Z",
};

const supersededReport: ServiceReportSummary = {
  ...finalizedReport,
  id: "10000000-0000-4000-8000-000000000003",
  version: 1,
  status: "superseded",
  finalizedAt: "2026-09-13T11:00:00.000Z",
  createdAt: "2026-09-13T10:00:00.000Z",
  updatedAt: "2026-09-15T11:00:00.000Z",
};

describe("field-service report history UI", () => {
  beforeEach(() => {
    state.crmMutation.mockReset();
    state.crmMutation.mockResolvedValue({ deleted: true });
    state.crmRead.mockReset();
  });
  afterEach(cleanup);

  it("makes finalized history and active drafts discoverable without mutating them", () => {
    const { container } = render(
      localized(
        <ReportsWorkspace
          initialPage={{
            reports: [finalizedReport, supersededReport, draftReport],
            nextCursor: null,
          }}
          timezone="Asia/Jerusalem"
        />,
      ),
    );

    expect(
      screen
        .getByRole("link", {
          name: "Open report FS-2026-0021, version 2",
        })
        .getAttribute("href"),
    ).toBe(`/field-service/reports/${finalizedReport.id}`);
    expect(
      screen
        .getByRole("link", {
          name: "Open report FS-2026-0021, version 1",
        })
        .getAttribute("href"),
    ).toBe(`/field-service/reports/${supersededReport.id}`);
    expect(
      screen
        .getByRole("link", { name: "Open case FS-2026-0022" })
        .getAttribute("href"),
    ).toBe(`/field-service/cases/${draftReport.caseId}`);
    expect(
      [...container.querySelectorAll(".or-badge")].map(
        (badge) => badge.textContent,
      ),
    ).toEqual(["Finalized", "Replaced by a newer version", "Draft"]);
    expect(
      screen
        .getByRole("link", { name: "Reports" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.queryByText(finalizedReport.id.slice(0, 8))).toBeNull();
    expect(state.crmRead).not.toHaveBeenCalled();
  });

  it("confirms deletion and immediately removes every version of the report", async () => {
    render(
      localized(
        <ReportsWorkspace
          initialPage={{
            reports: [finalizedReport, supersededReport, draftReport],
            nextCursor: null,
          }}
          timezone="UTC"
        />,
      ),
    );

    function deleteButton() {
      const button = screen.getAllByRole("button", {
        name: "Delete report FS-2026-0021, all versions",
      })[0];
      if (button === undefined)
        throw new Error("Delete action was not rendered");
      return button;
    }

    fireEvent.click(deleteButton());
    expect(screen.getByText("Delete this report?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(state.crmMutation).not.toHaveBeenCalled();
    expect(screen.getAllByText("Synthetic control-board fault")).toHaveLength(
      2,
    );

    fireEvent.click(deleteButton());
    fireEvent.click(screen.getByRole("button", { name: "Delete report" }));

    await waitFor(() =>
      expect(state.crmMutation).toHaveBeenCalledWith(
        `/api/field-service/reports/${finalizedReport.id}`,
        {},
        { method: "DELETE" },
      ),
    );
    await screen.findByText("Report FS-2026-0021 was deleted.");
    expect(screen.queryByText("Synthetic control-board fault")).toBeNull();
    expect(screen.getByText("Synthetic refrigeration fault")).toBeTruthy();
  });

  it("appends the next stable page without replacing visible history", async () => {
    state.crmRead.mockResolvedValue({
      reports: [draftReport],
      nextCursor: null,
    });
    render(
      localized(
        <ReportsWorkspace
          initialPage={{
            reports: [finalizedReport],
            nextCursor: {
              updatedAt: finalizedReport.updatedAt,
              id: finalizedReport.id,
            },
          }}
          timezone="UTC"
        />,
      ),
    );

    fireEvent.change(screen.getByLabelText("Search reports"), {
      target: { value: "not-applied" },
    });
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "superseded" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Load older reports" }));

    await screen.findByText("Fictional Customer Two");
    expect(screen.getByText("Fictional Customer")).toBeTruthy();
    expect(state.crmRead).toHaveBeenCalledWith(
      expect.stringContaining(
        `cursorId=${encodeURIComponent(finalizedReport.id)}`,
      ),
      expect.any(AbortSignal),
    );
    expect(state.crmRead.mock.calls[0]?.[0]).toContain(
      `cursorAt=${encodeURIComponent(finalizedReport.updatedAt)}`,
    );
    expect(state.crmRead.mock.calls[0]?.[0]).not.toContain("q=not-applied");
    expect(state.crmRead.mock.calls[0]?.[0]).not.toContain("status=superseded");
    expect(
      screen.queryByRole("button", { name: "Load older reports" }),
    ).toBeNull();
  });

  it("keeps subsequent pages on the last successfully applied filters", async () => {
    state.crmRead
      .mockResolvedValueOnce({
        reports: [finalizedReport],
        nextCursor: {
          updatedAt: finalizedReport.updatedAt,
          id: finalizedReport.id,
        },
      })
      .mockResolvedValueOnce({ reports: [supersededReport], nextCursor: null });
    render(
      localized(
        <ReportsWorkspace
          initialPage={{ reports: [draftReport], nextCursor: null }}
          timezone="UTC"
        />,
      ),
    );

    fireEvent.change(screen.getByLabelText("Search reports"), {
      target: { value: "Fictional" },
    });
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "finalized" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(state.crmRead).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Search reports"), {
      target: { value: "not-applied" },
    });
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "superseded" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older reports" }));

    await waitFor(() => expect(state.crmRead).toHaveBeenCalledTimes(2));
    const url = state.crmRead.mock.calls[1]?.[0] as string;
    expect(url).toContain("q=Fictional");
    expect(url).toContain("status=finalized");
    expect(url).not.toContain("not-applied");
    expect(url).toContain(`cursorId=${encodeURIComponent(finalizedReport.id)}`);
  });

  it("shows a filter-aware empty state and can return to all reports", async () => {
    state.crmRead.mockResolvedValue({ reports: [], nextCursor: null });
    render(
      localized(
        <ReportsWorkspace
          initialPage={{ reports: [], nextCursor: null }}
          timezone="UTC"
        />,
      ),
    );

    fireEvent.change(screen.getByLabelText("Search reports"), {
      target: { value: "missing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() =>
      expect(state.crmRead).toHaveBeenCalledWith(
        expect.stringContaining("q=missing"),
        expect.any(AbortSignal),
      ),
    );
    expect(screen.getByText("No reports match these filters.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show all reports" }));
    await waitFor(() => expect(state.crmRead).toHaveBeenCalledTimes(2));
    expect(
      screen.getByLabelText<HTMLInputElement>("Search reports").value,
    ).toBe("");
  });
});
