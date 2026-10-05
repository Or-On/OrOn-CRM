// @vitest-environment jsdom
import "./dialog-test-support";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FieldServiceFeatureState,
  ServiceCaseSummary,
  ServiceInquiry,
} from "@or-on/crm";
import {
  ServiceInquiryRegister,
  ServiceManagerOverview,
} from "../src/features/service-manager";
import { FieldServiceWorkspace } from "../src/features/field-service";
import { useVisibleRefresh } from "../src/features/live-refresh";
import { localized } from "./localized";

const calls = vi.hoisted(() => ({
  refresh: vi.fn(),
  read: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: calls.refresh }),
}));
vi.mock("../src/features/crm", () => ({
  crmRead: calls.read,
  crmMutation: calls.mutate,
  csrfToken: () => "fictional",
}));
const feature: FieldServiceFeatureState = {
  key: "field_service",
  available: true,
  enabled: true,
  effective: true,
  whatsAppIntakeEnabled: false,
  aiSchedulingEnabled: false,
  ocrEnabled: false,
  sharedTechnicianLoginEnabled: false,
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
const serviceCase: ServiceCaseSummary = {
  id: "10000000-0000-4000-8000-000000000001",
  reference: "FS-NEW-FORM",
  customerContactId: "20000000-0000-4000-8000-000000000001",
  customerName: "Fictional submitter",
  serviceLocationId: null,
  serviceLocationName: null,
  serviceLocationAddress: null,
  status: "awaiting_scheduling",
  title: "New digital form case",
  faultDescription: "Fictional fault",
  warrantyStatus: "unknown",
  productType: null,
  productModel: null,
  serialNumber: null,
  priority: "normal",
  createdAt: "2026-10-05T08:00:00Z",
  updatedAt: "2026-10-05T08:00:00Z",
};
const inquiry: ServiceInquiry = {
  id: serviceCase.id,
  reference: "IN-NEW-FORM",
  customer: "Fictional submitter",
  location: "Fictional site",
  subject: "New digital form inquiry",
  faultDescription: "Fictional fault",
  openedAt: serviceCase.createdAt,
  closedAt: null,
  status: "open",
  caseId: serviceCase.id,
  caseStatus: serviceCase.status,
  technician: null,
  appointmentAt: null,
  appointmentEnd: null,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function tick(milliseconds = 5000) {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds));
}
async function interact(work: () => void) {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}
function Probe({ refresh }: { readonly refresh: () => Promise<void> }) {
  useVisibleRefresh(refresh);
  return (
    <>
      <input aria-label="Draft" />
      <dialog open>
        <span>Editing</span>
      </dialog>
    </>
  );
}

describe("external service submission visibility", () => {
  it("keeps expanded older inquiries until the user explicitly returns to the latest page", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ inquiries: [inquiry], nextCursor: null }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    render(
      localized(
        <ServiceInquiryRegister
          initialPage={{
            inquiries: [{ ...inquiry, id: "first", reference: "IN-FIRST" }],
            nextCursor: { openedAt: inquiry.openedAt, id: "first" },
          }}
          timezone="Asia/Jerusalem"
        />,
      ),
    );
    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    });
    await tick(15000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByText("IN-FIRST")).toBeTruthy();
    expect(screen.getByText("IN-NEW-FORM")).toBeTruthy();
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ inquiries: [inquiry], nextCursor: null })),
    );
    await interact(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Return to latest inquiries" }),
      );
    });
    expect(screen.queryByText("IN-FIRST")).toBeNull();
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ inquiries: [inquiry], nextCursor: null })),
    );
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("keeps expanded older service cases and resumes polling only after returning to the latest page", async () => {
    calls.read.mockResolvedValue({ cases: [serviceCase], nextCursor: null });
    render(
      localized(
        <FieldServiceWorkspace
          appointments={[]}
          cases={[{ ...serviceCase, id: "first", reference: "FS-FIRST" }]}
          nextCaseCursor={{ updatedAt: serviceCase.updatedAt, id: "first" }}
          contacts={[]}
          feature={feature}
          technicians={[]}
          timezone="Asia/Jerusalem"
          canManage
          canOperate
        />,
      ),
    );
    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: "Load more cases" }));
    });
    await tick(15000);
    expect(calls.read).toHaveBeenCalledTimes(1);
    expect(screen.getByText("FS-FIRST")).toBeTruthy();
    expect(screen.getByText("FS-NEW-FORM")).toBeTruthy();
    await interact(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Return to latest cases" }),
      );
    });
    expect(screen.queryByText("FS-FIRST")).toBeNull();
    await tick();
    expect(calls.read).toHaveBeenCalledTimes(3);
  });
  it("pauses while hidden, editing or in a dialog, prevents overlapping requests and cleans up", async () => {
    let finish: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<Probe refresh={refresh} />);
    await tick();
    expect(refresh).not.toHaveBeenCalled();
    view.container.querySelector("dialog")?.removeAttribute("open");
    const draft = screen.getByRole("textbox", { name: "Draft" });
    draft.focus();
    await tick();
    expect(refresh).not.toHaveBeenCalled();
    draft.blur();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await tick(15000);
    expect(refresh).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await tick(15000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await interact(() => {
      finish?.();
    });
    view.unmount();
    await tick();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("refreshes the service overview after five seconds without changing its selected period", async () => {
    const metrics = {
      incomingCalls: 0,
      incomingMessages: 0,
      opened: 0,
      closed: 0,
      since: "2026-10-01",
      until: "2026-10-05",
    };
    const view = render(
      localized(
        <ServiceManagerOverview
          tenantName="Fictional tenant"
          metrics={metrics}
          period="week"
        />,
      ),
    );
    calls.refresh.mockImplementation(() =>
      view.rerender(
        localized(
          <ServiceManagerOverview
            tenantName="Fictional tenant"
            metrics={{ ...metrics, opened: 1 }}
            period="week"
          />,
        ),
      ),
    );
    await tick(4999);
    expect(calls.refresh).not.toHaveBeenCalled();
    await tick(1);
    expect(calls.refresh).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Requests opened").parentElement?.textContent,
    ).toContain("1");
    expect(
      screen
        .getByRole("link", { name: "Last 7 days" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });
  it("loads a submitted inquiry with applied filters while preserving a typed filter draft", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ inquiries: [], nextCursor: null })),
      );
    vi.stubGlobal("fetch", fetcher);
    render(
      localized(
        <ServiceInquiryRegister
          initialPage={{ inquiries: [], nextCursor: null }}
          timezone="Asia/Jerusalem"
        />,
      ),
    );
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "open" },
    });
    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: "Show" }));
    });
    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "Unsubmitted filter draft" },
    });
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ inquiries: [inquiry], nextCursor: null })),
    );
    await tick();
    expect(screen.getByText("New digital form inquiry")).toBeTruthy();
    expect(fetcher.mock.lastCall?.[0]).toBe(
      "/api/service-inquiries?status=open",
    );
    expect(screen.getByLabelText<HTMLInputElement>("Search").value).toBe(
      "Unsubmitted filter draft",
    );
  });
  it("shows an externally created case without a manual reload and pauses for an open creation draft", async () => {
    calls.read.mockResolvedValue({ cases: [serviceCase], nextCursor: null });
    render(
      localized(
        <FieldServiceWorkspace
          appointments={[]}
          cases={[]}
          contacts={[]}
          feature={feature}
          technicians={[]}
          timezone="Asia/Jerusalem"
          canManage
          canOperate
        />,
      ),
    );
    expect(screen.queryByText("New digital form case")).toBeNull();
    await tick();
    expect(screen.getByText("New digital form case")).toBeTruthy();
    expect(calls.read).toHaveBeenCalledWith(
      "/api/field-service/cases?limit=50",
    );
    fireEvent.click(screen.getByRole("button", { name: "New service case" }));
    const draft = screen.getByRole("textbox", { name: "Case title" });
    fireEvent.change(draft, { target: { value: "Preserved manual draft" } });
    const count = calls.read.mock.calls.length;
    await tick(15000);
    expect(calls.read).toHaveBeenCalledTimes(count);
    expect((draft as HTMLInputElement).value).toBe("Preserved manual draft");
  });
});
