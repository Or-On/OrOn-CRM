// @vitest-environment jsdom
import "./dialog-test-support";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FieldServiceFeatureState,
  ServiceCaseDossier,
  ServiceReportDocument,
} from "@or-on/crm";

import {
  FieldServiceSettings,
  FieldServiceWorkspace,
  ServiceCaseWorkspace,
} from "../src/features/field-service";
import { localized } from "./localized";

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  report: undefined as ServiceReportDocument | undefined,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  redirect: (destination: string) => {
    throw new Error(`redirect:${destination}`);
  },
  useRouter: () => ({ refresh: state.refresh }),
}));
vi.mock("next/image", () => ({
  default: ({ alt, src }: { readonly alt: string; readonly src: string }) => (
    <span aria-label={alt || "report image"} data-src={src} role="img" />
  ),
}));
vi.mock("@or-on/crm", () => ({
  getServiceReportDocument: () => Promise.resolve(state.report),
  nextServiceCaseStatuses: () => ["scheduled", "cancelled"],
}));
vi.mock("../src/features/auth", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  withCurrentTenant: async (
    _permission: string,
    work: (sql: unknown) => Promise<unknown>,
  ) => work({}),
}));
vi.mock("../src/features/crm", () => ({
  crmMutation: vi.fn(),
  csrfToken: () => "test-csrf",
}));

const feature: FieldServiceFeatureState = {
  key: "field_service",
  available: true,
  enabled: true,
  effective: true,
  whatsAppIntakeEnabled: false,
  aiSchedulingEnabled: false,
  ocrEnabled: true,
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

const serviceCase = {
  id: "10000000-0000-4000-8000-000000000001",
  reference: "FS-2026-0001",
  customerContactId: "20000000-0000-4000-8000-000000000001",
  customerName: "לקוח לדוגמה",
  serviceLocationId: null,
  serviceLocationName: null,
  serviceLocationAddress: null,
  status: "awaiting_scheduling" as const,
  title: "תקלה במכשיר",
  faultDescription: "המכשיר אינו נדלק",
  warrantyStatus: "unknown" as const,
  productType: null,
  productModel: null,
  serialNumber: null,
  priority: "normal" as const,
  createdAt: "2026-09-14T08:00:00.000Z",
  updatedAt: "2026-09-14T08:00:00.000Z",
};

const dossier: ServiceCaseDossier = {
  serviceCase,
  customer: {
    contactId: serviceCase.customerContactId,
    nationalIdMasked: "••••••567",
    preferredLanguage: "he",
    address: null,
    classifications: [],
    locations: [],
    documents: [],
  },
  appointments: [],
  visits: [],
  reports: [],
  conversationIds: [],
  callSessionIds: [],
  conversations: [],
  calls: [],
  attachments: [],
  ocrResults: [],
  statusHistory: [],
  summaries: [],
  audit: [],
};

describe("field-service UI contracts", () => {
  beforeEach(() => {
    state.refresh.mockReset();
    state.report = undefined;
  });

  afterEach(cleanup);

  it("offers distinct desktop upload and rear-camera capture controls", () => {
    const { container } = render(
      localized(
        <ServiceCaseWorkspace
          canManage
          canOperate
          canReadVoice
          dossier={dossier}
          feature={feature}
          linkCandidates={{ calls: [], conversations: [] }}
          technicians={[]}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    const filePicker =
      container.querySelector<HTMLInputElement>('input[name="file"]');
    const cameraPicker = container.querySelector<HTMLInputElement>(
      'input[name="cameraFile"]',
    );

    expect(filePicker?.type).toBe("file");
    expect(filePicker?.hasAttribute("capture")).toBe(false);
    expect(filePicker?.accept).toContain("application/pdf");
    expect(cameraPicker?.type).toBe("file");
    expect(cameraPicker?.getAttribute("capture")).toBe("environment");
    expect(cameraPicker?.accept).toBe("image/jpeg,image/png,image/webp");
    expect(screen.getByRole("option", { name: "Fault photo" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Module photo" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Product label for OCR" }),
    ).toBeTruthy();
  });

  it("offers a grounded calendar suggestion only when AI scheduling is ready", () => {
    render(
      localized(
        <FieldServiceWorkspace
          appointments={[]}
          canManage
          canOperate
          cases={[serviceCase]}
          contacts={[]}
          feature={{
            ...feature,
            aiSchedulingEnabled: true,
            calendarAccess: "read_only",
            calendarProvider: "crm_calendar",
            readiness: {
              ...feature.readiness,
              calendarCanSuggest: true,
            },
          }}
          technicians={[
            {
              id: "60000000-0000-4000-8000-000000000001",
              linkedUserId: "70000000-0000-4000-8000-000000000001",
              employeeIdentifier: "TECH-42",
              fullName: "Fictional technician",
              phone: null,
              email: null,
              identityVerification: "verified",
              active: true,
            },
          ]}
          timezone="Asia/Jerusalem"
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(
      screen.getByRole("button", { name: "Suggest next available" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/create no event before authorized approval/iu),
    ).toBeTruthy();
  });

  it("shows tenant administrators the missing runtime dependencies", () => {
    render(
      localized(
        <FieldServiceSettings
          initialState={{
            ...feature,
            whatsAppIntakeEnabled: true,
            ocrEnabled: true,
          }}
          runtimeReadiness={{
            aiProviderConfigured: false,
            protectedFieldsConfigured: false,
            privateStorageConfigured: false,
            storageBackend: "gcs",
          }}
        />,
      ),
    );

    expect(screen.getByText("AI & OCR provider")).toBeTruthy();
    expect(screen.getByText("Protected sensitive fields")).toBeTruthy();
    expect(screen.getByText("Private evidence storage · gcs")).toBeTruthy();
    expect(screen.getByText(/Missing requirements:/u)).toBeTruthy();
  });

  it("renders a finalized Hebrew report from its immutable tenant-brand snapshot", async () => {
    state.report = {
      revision: {
        id: "30000000-0000-4000-8000-000000000001",
        reportId: "40000000-0000-4000-8000-000000000001",
        version: 2,
        status: "finalized",
        diagnosis: "כשל בלוח הבקרה",
        workPerformed: "הלוח הוחלף ונבדק",
        partReplaced: true,
        replacementPartDetails: "לוח CTRL-42",
        technicianNotes: null,
        finalizedAt: "2026-09-14T10:00:00.000Z",
      },
      serviceCase,
      customer: dossier.customer,
      visit: {
        id: "50000000-0000-4000-8000-000000000001",
        caseId: serviceCase.id,
        appointmentId: null,
        technicianId: "60000000-0000-4000-8000-000000000001",
        visitNumber: 1,
        status: "reported",
        arrivalAt: "2026-09-14T08:00:00.000Z",
        departureAt: "2026-09-14T09:00:00.000Z",
        durationSeconds: 3600,
        arrivalSignatureObjectId: "70000000-0000-4000-8000-000000000001",
        departureSignatureObjectId: "80000000-0000-4000-8000-000000000001",
        arrivalIdentity: { fullName: "דנה הטכנאית" },
        departureIdentity: { fullName: "דנה הטכנאית" },
      },
      technician: {
        id: "60000000-0000-4000-8000-000000000001",
        linkedUserId: null,
        employeeIdentifier: "TECH-42",
        fullName: "דנה הטכנאית",
        phone: null,
        email: null,
        identityVerification: "verified",
        active: true,
      },
      customerSnapshot: { name: "לקוח לדוגמה" },
      productSnapshot: { model: "MODEL-42", serialNumber: "000123" },
      branding: {
        businessName: "שירות הכוכב",
        logoData: null,
        logoContentType: null,
        accentToken: "violet",
        reportHeader: "שירות מקצועי בכל ביקור",
        reportFooter: "תודה שבחרתם בנו",
        businessEmail: "service@example.test",
        businessPhone: "+97230000000",
        businessAddress: "רחוב הדוגמה 1",
        locale: "he-IL",
        timezone: "Asia/Jerusalem",
      },
      attachments: [],
    };
    const { default: ServiceReportPage } =
      await import("../src/app/field-service/reports/[id]/page");
    const view = await ServiceReportPage({
      params: Promise.resolve({ id: state.report.revision.id }),
    });
    const { container } = render(view);

    expect(container.querySelector("main")?.getAttribute("dir")).toBe("rtl");
    expect(
      container.querySelector("main")?.getAttribute("data-tenant-accent"),
    ).toBe("violet");
    expect(screen.getByText("שירות הכוכב")).toBeTruthy();
    expect(screen.getByText("שירות מקצועי בכל ביקור")).toBeTruthy();
    expect(screen.getByText("תודה שבחרתם בנו")).toBeTruthy();
    expect(screen.getByText("••••••567")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "הורדת Excel" }).getAttribute("href"),
    ).toBe(
      "/api/field-service/reports/30000000-0000-4000-8000-000000000001/export?format=xlsx",
    );
    expect(screen.queryByText(/Brimag|Pro Touch/iu)).toBeNull();
  });
});
