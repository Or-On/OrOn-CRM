// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ServiceInquiry,
  ServiceInquiryPage,
  ServiceAttachmentSummary,
  TicketSummary,
} from "@or-on/crm";
import {
  ServiceInquiryDetail,
  ServiceInquiryRegister,
  ServiceManagerOverview,
} from "../src/features/service-manager";
import { VisitWorkflow } from "../src/features/field-service";
import { AppShell } from "../src/features/shell";
import { localized } from "./localized";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/tickets",
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark", setTheme: vi.fn() }),
}));
const item: ServiceInquiry = {
  id: "10000000-0000-4000-8000-000000000001",
  reference: "IN-001",
  customer: "Example customer",
  location: "Example site",
  subject: "Broken cooling unit",
  faultDescription: "The unit stops cooling after ten minutes",
  openedAt: "2026-09-28T08:00:00Z",
  closedAt: null,
  status: "scheduled",
  caseId: "20000000-0000-4000-8000-000000000001",
  caseStatus: "scheduled",
  technician: "Example technician",
  appointmentAt: "2026-09-29T09:00:00Z",
  appointmentEnd: "2026-09-29T10:00:00Z",
};
const page: ServiceInquiryPage = { inquiries: [item], nextCursor: null };
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("service manager", () => {
  it("shows the four requested measures without delivery diagnostics", () => {
    render(
      localized(
        <ServiceManagerOverview
          tenantName="Example service"
          metrics={{
            incomingCalls: 7,
            incomingMessages: 19,
            opened: 4,
            closed: 2,
            since: "2026-09-01",
            until: "2026-09-28",
          }}
          period="month"
        />,
        "he",
      ),
    );
    for (const label of [
      "שיחות שהתקבלו",
      "הודעות שהתקבלו",
      "קריאות שירות שנפתחו",
      "קריאות שירות שנסגרו",
    ])
      expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText("שיעור מסירה סופית")).toBeNull();
    expect(
      screen.getByRole("link", { name: "החודש" }).getAttribute("aria-current"),
    ).toBe("page");
  });
  it("starts with all inquiries and exposes opening dates and appointments", () => {
    render(
      localized(
        <ServiceInquiryRegister initialPage={page} timezone="Asia/Jerusalem" />,
        "he",
      ),
    );
    expect(screen.getByLabelText<HTMLSelectElement>("סטטוס").value).toBe("all");
    expect(
      screen.getByRole("columnheader", { name: "תאריך פתיחה" }),
    ).toBeTruthy();
    expect(screen.getByText("תואם טכנאי", { selector: "span" })).toBeTruthy();
    expect(
      screen.getByRole("cell", { name: /Example technician/ }),
    ).toBeTruthy();
  });
  it("applies date and status filters on the server", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve(page) });
    vi.stubGlobal("fetch", fetcher);
    render(
      localized(
        <ServiceInquiryRegister initialPage={page} timezone="Asia/Jerusalem" />,
        "en",
      ),
    );
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "telephone" },
    });
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-09-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining("status=telephone"),
      ),
    );
    expect(fetcher.mock.calls[0]?.[0]).toContain("since=2026-09-01");
  });
  it("shows the fault, appointment and both sources of photos prominently", () => {
    const attachments = [
      {
        id: "photo-1",
        objectId: "object-1",
        source: "customer",
        category: "customer_photo",
        contentType: "image/jpeg",
        caption: "Customer fault photo",
        createdAt: item.openedAt,
      },
      {
        id: "photo-2",
        objectId: "object-2",
        source: "technician",
        category: "after_photo",
        contentType: "image/jpeg",
        caption: "Technician repair photo",
        createdAt: item.openedAt,
      },
    ] as unknown as ServiceAttachmentSummary[];
    render(
      localized(
        <ServiceInquiryDetail
          item={item}
          inquiry={null}
          attachments={attachments}
          timezone="Asia/Jerusalem"
          canResolve={false}
          ticket={
            {
              emergency: null,
              sourceConversationId: null,
            } as unknown as TicketSummary
          }
          emergencyLabel={null}
          canMarkEmergency={false}
        />,
        "he",
      ),
    );
    expect(screen.getByText(item.faultDescription ?? "")).toBeTruthy();
    expect(screen.getByText("תואם טכנאי ליום")).toBeTruthy();
    expect(
      screen
        .getByRole("img", { name: "Customer fault photo" })
        .getAttribute("src"),
    ).toContain("/api/field-service/attachments/object-1");
    expect(
      screen
        .getByRole("img", { name: /Technician repair photo/ })
        .getAttribute("src"),
    ).toContain("/api/field-service/attachments/object-2");
    expect(screen.queryByText("ערוץ מקור")).toBeNull();
    expect(screen.queryByText("אושר על ידי")).toBeNull();
  });
  it("retains an honest label for historical records with no resolution method", () => {
    render(
      localized(
        <ServiceInquiryRegister
          initialPage={{
            inquiries: [{ ...item, status: "closed" }],
            nextCursor: null,
          }}
          timezone="Asia/Jerusalem"
        />,
        "he",
      ),
    );
    expect(
      screen.getByText("סגור · סוג טיפול לא תועד", { selector: "span" }),
    ).toBeTruthy();
  });

  it("keeps emergency calls visible in the simplified register", () => {
    render(
      localized(
        <ServiceInquiryRegister
          initialPage={{
            inquiries: [{ ...item, emergency: true }],
            nextCursor: null,
          }}
          timezone="Asia/Jerusalem"
          emergencyLabel="קריאה אדומה"
        />,
        "he",
      ),
    );
    expect(screen.getByText("קריאה אדומה")).toBeTruthy();
  });
  it("reduces manager attendance to arrival and departure", () => {
    render(
      localized(
        <VisitWorkflow
          simple
          canWork={false}
          timezone="Asia/Jerusalem"
          visit={
            {
              id: item.id,
              status: "assigned",
              arrivalAt: null,
              departureAt: null,
            } as never
          }
        />,
        "he",
      ),
    );
    expect(screen.getByText("הגעתי")).toBeTruthy();
    expect(screen.getByText("יצאתי")).toBeTruthy();
    expect(screen.queryByText("תחילת עבודה")).toBeNull();
    expect(screen.queryByText("מועד מתוכנן")).toBeNull();
  });
  it("hides advanced navigation only in the opted-in experience", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const membership = {
      tenantId: item.id,
      tenantName: "Example",
      tenantSlug: "example",
      role: "owner" as const,
    };
    const session = {
      user: { id: item.id, email: "operator@example.test", isSuperuser: false },
      tenant: membership,
      memberships: [membership],
      expiresAt: "2030-01-01T00:00:00Z",
      permissions: [
        "crm:read",
        "voice:read",
        "field-service:read",
        "platform:read",
      ] as const,
      applicationScope: "workspace" as const,
    };
    const features = [
      "contacts",
      "tickets",
      "field_service",
      "whatsapp",
      "voice",
      "agents",
    ];
    const { container, rerender } = render(
      localized(
        <AppShell session={session} serviceManager enabledFeatures={features}>
          <span>Service content</span>
        </AppShell>,
      ),
    );
    const navigationElement = container.querySelector<HTMLElement>(
      "#workspace-navigation",
    );
    if (!navigationElement) throw new Error("Missing workspace navigation");
    const navigation = within(navigationElement);
    expect(navigation.queryByRole("link", { name: "Voice" })).toBeTruthy();
    expect(container.querySelector('a[href="/inbox"]')).toBeTruthy();
    expect(container.querySelector('a[href="/orchestration"]')).toBeNull();
    expect(container.querySelector('a[href="/tickets"]')).toBeTruthy();
    rerender(
      localized(
        <AppShell session={session} enabledFeatures={features}>
          <span>Service content</span>
        </AppShell>,
      ),
    );
    expect(container.querySelector('a[href="/voice"]')).toBeTruthy();
    expect(container.querySelector('a[href="/inbox"]')).toBeTruthy();
  });
});
