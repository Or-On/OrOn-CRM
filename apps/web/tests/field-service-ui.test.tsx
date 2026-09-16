// @vitest-environment jsdom
import "./dialog-test-support";

import {
  act,
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
  ReportRevision,
  ServiceCaseDossier,
  ServiceReportDocument,
  ServiceVisit,
} from "@or-on/crm";

import {
  FieldServiceSettings,
  FieldServiceWorkspace,
  ServiceCaseWorkspace,
} from "../src/features/field-service";
import { localized } from "./localized";

const state = vi.hoisted(() => ({
  crmMutation: vi.fn(),
  refresh: vi.fn(),
  report: undefined as ServiceReportDocument | undefined,
  withCurrentTenant: vi.fn(
    async (
      _permission: string,
      work: (sql: unknown) => Promise<unknown>,
    ): Promise<unknown> => work({}),
  ),
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
  withCurrentTenant: state.withCurrentTenant,
}));
vi.mock("../src/features/crm", () => ({
  crmMutation: state.crmMutation,
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
  technicianBriefing: {
    customer: {
      name: serviceCase.customerName,
      preferredLanguage: "he",
      locationName: null,
      locationAddress: null,
    },
    issue: {
      title: serviceCase.title,
      description: serviceCase.faultDescription,
      priority: serviceCase.priority,
      warrantyStatus: serviceCase.warrantyStatus,
      productType: null,
      productModel: null,
      serialNumber: null,
    },
    nextAppointment: null,
    currentVisits: [],
    whatsappSummary: null,
    voiceSummary: null,
    previousService: [],
  },
};

describe("field-service UI contracts", () => {
  beforeEach(() => {
    state.crmMutation.mockReset();
    state.refresh.mockReset();
    state.report = undefined;
    state.withCurrentTenant.mockClear();
  });

  afterEach(cleanup);

  it("renders every case lifecycle value as a clear English label", () => {
    const statuses = [
      "awaiting_scheduling",
      "scheduled",
      "in_progress",
      "completed",
      "closed",
      "cancelled",
    ] as const;
    const expected = [
      "Awaiting scheduling",
      "Scheduled",
      "In progress",
      "Completed",
      "Closed",
      "Cancelled",
    ];
    const { container } = render(
      localized(
        <FieldServiceWorkspace
          appointments={[]}
          canManage
          canOperate
          cases={statuses.map((status, index) => ({
            ...serviceCase,
            id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
            reference: `FS-2026-${String(index + 1).padStart(4, "0")}`,
            status,
          }))}
          contacts={[]}
          feature={feature}
          technicians={[]}
          timezone="Asia/Jerusalem"
        />,
      ),
    );

    const badgeLabels = [...container.querySelectorAll(".or-badge")].map(
      (element) => element.textContent,
    );
    for (const label of expected) expect(badgeLabels).toContain(label);
    expect(container.textContent).not.toContain("awaiting_scheduling");
    expect(container.textContent).not.toContain("in_progress");
  });

  it("localizes case, warranty and OCR states and isolates mixed-direction evidence", () => {
    const mixedCase = {
      ...serviceCase,
      customerName: "יוסי Cohen",
      serviceLocationName: "סניף Tel Aviv",
      title: "תקלה בדגם Bosch X-500?",
      faultDescription: "Error E24 — המכונה לא מנקזת.",
      productModel: "Bosch דגם X-500",
      serialNumber: "SN-42/אב",
    };
    const { container } = render(
      localized(
        <ServiceCaseWorkspace
          canManage
          canOperate
          canReadVoice
          dossier={{
            ...dossier,
            serviceCase: mixedCase,
            attachments: [
              {
                id: "90000000-0000-4000-8000-000000000001",
                objectId: "91000000-0000-4000-8000-000000000001",
                visitId: null,
                reportRevisionId: null,
                category: "product_label",
                source: "technician",
                processingStatus: "available",
                contentType: "image/jpeg",
                byteSize: 2048,
                caption: null,
                createdAt: "2026-09-14T08:00:00.000Z",
              },
            ],
            ocrResults: [
              {
                id: "92000000-0000-4000-8000-000000000001",
                attachmentId: "90000000-0000-4000-8000-000000000001",
                status: "review_required",
                proposedFields: { productModel: "Bosch X-500" },
                confirmedFields: {},
                manuallyConfirmedFields: [],
                confidence: 0.81,
                errorSafe: null,
                attempt: 1,
              },
            ],
            statusHistory: [
              {
                fromStatus: null,
                toStatus: "awaiting_scheduling",
                reason: "נוצר מ-WhatsApp intake",
                changedAt: "2026-09-14T08:00:00.000Z",
              },
            ],
          }}
          feature={feature}
          linkCandidates={{ calls: [], conversations: [] }}
          technicians={[]}
          timezone="Asia/Jerusalem"
        />,
        "he",
      ),
    );

    expect(screen.getAllByText("ממתין לתזמון").length).toBeGreaterThan(0);
    expect(screen.getAllByText("לא ידוע").length).toBeGreaterThan(0);
    expect(screen.getByText("תווית מוצר")).toBeTruthy();
    expect(screen.getByText(/OCR · נדרשת בדיקה · 81%/u)).toBeTruthy();
    expect(screen.getByRole("option", { name: "מתוזמן" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "בוטל" })).toBeTruthy();
    expect(container.textContent).not.toContain("review_required");
    expect(container.textContent).not.toContain("awaiting_scheduling");

    expect(
      screen
        .getByRole("heading", { level: 1, name: mixedCase.title })
        .getAttribute("dir"),
    ).toBe("auto");
    expect(
      screen
        .getAllByText(mixedCase.customerName, { selector: "bdi" })[0]
        ?.getAttribute("dir"),
    ).toBe("auto");
    expect(
      screen.getByText(mixedCase.faultDescription).getAttribute("dir"),
    ).toBe("auto");
    expect(screen.getByText("נוצר מ-WhatsApp intake").getAttribute("dir")).toBe(
      "auto",
    );
  });

  it("renders a bounded technician briefing without exposing raw channel history", () => {
    render(
      localized(
        <ServiceCaseWorkspace
          canManage={false}
          canOperate={false}
          canReadVoice={false}
          dossier={{
            ...dossier,
            conversations: [
              {
                conversationId: "30000000-0000-4000-8000-000000000001",
                messages: [
                  {
                    id: "31000000-0000-4000-8000-000000000001",
                    conversationId: "30000000-0000-4000-8000-000000000001",
                    direction: "inbound",
                    senderType: "contact",
                    contentType: "text",
                    contentText: "RAW CUSTOMER TRANSCRIPT",
                    status: "received",
                    providerMessageId: null,
                    createdAt: "2026-09-14T08:00:00.000Z",
                    reactions: [],
                    deliveryEvents: [],
                  },
                ],
              },
            ],
            technicianBriefing: {
              ...dossier.technicianBriefing,
              customer: {
                ...dossier.technicianBriefing.customer,
                locationName: "North site",
                locationAddress: "1 Fictional Street",
              },
              whatsappSummary: "Customer reported intermittent cooling.",
              voiceSummary: null,
              previousService: [
                {
                  caseReference: "FS-2025-0042",
                  caseTitle: "Previous cooling repair",
                  productType: "Air conditioner",
                  productModel: "Example 500",
                  serialNumber: "EXAMPLE-42",
                  visitNumber: 1,
                  visitStatus: "reported",
                  technicianName: "Fictional Technician",
                  servicedAt: "2025-09-14T08:00:00.000Z",
                  diagnosis: "Blocked filter",
                  workPerformed: "Filter replaced",
                  replacementPartDetails: "Example filter",
                },
              ],
            },
          }}
          feature={feature}
          linkCandidates={undefined}
          technicians={[]}
          timezone="Asia/Jerusalem"
        />,
      ),
    );

    expect(
      screen.getByRole("heading", { name: "What to know before arrival" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Customer reported intermittent cooling."),
    ).toBeTruthy();
    expect(screen.getByText(/Previous cooling repair/u)).toBeTruthy();
    expect(screen.queryByText("Voice summary")).toBeNull();
    expect(
      screen.queryByText("RAW CUSTOMER TRANSCRIPT", {
        selector: ".technician-briefing *",
      }),
    ).toBeNull();
  });

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
          timezone="Asia/Jerusalem"
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

  it("does not expose a stale report while a different visit report loads", async () => {
    const visit: ServiceVisit = {
      id: "50000000-0000-4000-8000-000000000001",
      caseId: serviceCase.id,
      appointmentId: null,
      technicianId: "60000000-0000-4000-8000-000000000001",
      visitNumber: 1,
      status: "assigned",
      arrivalAt: null,
      departureAt: null,
      durationSeconds: null,
      arrivalSignatureObjectId: null,
      departureSignatureObjectId: null,
      arrivalIdentity: null,
      departureIdentity: null,
    };
    const staleReport: ReportRevision = {
      id: "30000000-0000-4000-8000-000000000001",
      reportId: "40000000-0000-4000-8000-000000000001",
      version: 1,
      status: "draft",
      diagnosis: "Report from another visit",
      workPerformed: null,
      partReplaced: null,
      replacementPartDetails: null,
      technicianNotes: null,
      finalizedAt: null,
    };
    const selectedReport: ReportRevision = {
      ...staleReport,
      id: "30000000-0000-4000-8000-000000000002",
      reportId: "40000000-0000-4000-8000-000000000002",
      diagnosis: "Selected visit diagnosis",
    };
    let resolveReport!: (value: { report: ReportRevision }) => void;
    state.crmMutation.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReport = resolve;
      }),
    );
    render(
      localized(
        <ServiceCaseWorkspace
          canManage
          canOperate
          canReadVoice
          dossier={{ ...dossier, reports: [staleReport], visits: [visit] }}
          feature={feature}
          linkCandidates={{ calls: [], conversations: [] }}
          technicians={[]}
          timezone="Asia/Jerusalem"
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    expect(
      screen.queryByRole("dialog", { name: "Technician report" }),
    ).toBeNull();

    act(() => {
      resolveReport({ report: selectedReport });
    });
    const reportDialog = await screen.findByRole("dialog", {
      name: "Technician report",
    });
    expect(
      within(reportDialog).getByLabelText<HTMLTextAreaElement>("Diagnosis")
        .value,
    ).toBe("Selected visit diagnosis");
  });

  it("keeps mutation failures in the active dialog and clears them before switching", async () => {
    const visit: ServiceVisit = {
      id: "50000000-0000-4000-8000-000000000001",
      caseId: serviceCase.id,
      appointmentId: null,
      technicianId: "60000000-0000-4000-8000-000000000001",
      visitNumber: 1,
      status: "assigned",
      arrivalAt: null,
      departureAt: null,
      durationSeconds: null,
      arrivalSignatureObjectId: null,
      departureSignatureObjectId: null,
      arrivalIdentity: null,
      departureIdentity: null,
    };
    state.crmMutation.mockRejectedValueOnce(new Error("Synthetic failure"));
    render(
      localized(
        <ServiceCaseWorkspace
          canManage
          canOperate
          canReadVoice
          dossier={{ ...dossier, visits: [visit] }}
          feature={feature}
          linkCandidates={{ calls: [], conversations: [] }}
          technicians={[]}
          timezone="Asia/Jerusalem"
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Identify" }));
    const identityDialog = screen.getByRole("dialog", {
      name: "Identify technician",
    });
    fireEvent.change(within(identityDialog).getByLabelText("Full name"), {
      target: { value: "Fictional technician" },
    });
    fireEvent.click(
      within(identityDialog).getByRole("button", { name: "Confirm identity" }),
    );

    await waitFor(() =>
      expect(within(identityDialog).getByRole("alert").textContent).toContain(
        "Synthetic failure",
      ),
    );

    fireEvent.click(
      within(identityDialog).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByText("Synthetic failure")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    const uploadDialog = screen.getByRole("dialog", {
      name: "Upload evidence",
    });
    expect(within(uploadDialog).queryByRole("alert")).toBeNull();
  });

  it("does not carry a failed technician action into the create-case dialog", async () => {
    state.crmMutation.mockRejectedValueOnce(new Error("Technician failed"));
    render(
      localized(
        <FieldServiceWorkspace
          appointments={[]}
          canManage
          canOperate
          cases={[serviceCase]}
          contacts={[]}
          feature={feature}
          technicians={[]}
          timezone="Asia/Jerusalem"
        />,
      ),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Technicians" }));
    fireEvent.click(screen.getByRole("button", { name: "New technician" }));
    const technicianDialog = screen.getByRole("dialog", {
      name: "New technician",
    });
    fireEvent.change(within(technicianDialog).getByLabelText("Full name"), {
      target: { value: "Fictional technician" },
    });
    fireEvent.click(
      within(technicianDialog).getByRole("button", {
        name: "Add technician",
      }),
    );

    await waitFor(() =>
      expect(within(technicianDialog).getByRole("alert").textContent).toContain(
        "Technician failed",
      ),
    );
    fireEvent.click(
      within(technicianDialog).getByRole("button", { name: "Cancel" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "New service case" }));

    const createCaseDialog = screen.getByRole("dialog", {
      name: "New service case",
    });
    expect(within(createCaseDialog).queryByRole("alert")).toBeNull();
  });

  it("rejects malformed case routes before querying tenant data", async () => {
    const { default: ServiceCasePage } =
      await import("../src/app/field-service/cases/[id]/page");

    await expect(
      ServiceCasePage({ params: Promise.resolve({ id: "not-a-uuid" }) }),
    ).rejects.toThrow("not found");
    expect(state.withCurrentTenant).not.toHaveBeenCalled();
  });

  it("renders case timestamps in the tenant timezone instead of the host timezone", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const changedAt = "2026-09-14T23:30:00.000Z";
      const expected = new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Jerusalem",
      }).format(new Date(changedAt));
      const hostDefault = new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(changedAt));

      expect(expected).not.toBe(hostDefault);
      render(
        localized(
          <ServiceCaseWorkspace
            canManage
            canOperate
            canReadVoice
            dossier={{
              ...dossier,
              statusHistory: [
                {
                  fromStatus: null,
                  toStatus: "awaiting_scheduling",
                  reason: "Case created",
                  changedAt,
                },
              ],
            }}
            feature={feature}
            linkCandidates={{ calls: [], conversations: [] }}
            technicians={[]}
            timezone="Asia/Jerusalem"
          />,
        ),
      );

      expect(screen.getByText(expected)).toBeTruthy();
      expect(screen.queryByText(hostDefault)).toBeNull();
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("provides scoped recovery and a route back to service cases", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const retry = vi.fn();
    const { default: FieldServiceError } =
      await import("../src/app/field-service/error");
    render(
      localized(
        <FieldServiceError
          error={Object.assign(new Error("private detail"), {
            digest: "safe-digest",
          })}
          retry={retry}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(
      screen
        .getByRole("link", { name: "Back to service cases" })
        .getAttribute("href"),
    ).toBe("/field-service");
    await waitFor(() => expect(log).toHaveBeenCalled());
    log.mockRestore();
  });

  it("renders a field-service-shaped route loading state", async () => {
    const { default: FieldServiceLoading } =
      await import("../src/app/field-service/loading");
    render(localized(<FieldServiceLoading />));

    expect(
      screen
        .getByRole("main", { name: "Loading field service" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    expect(
      document.querySelectorAll(".field-service-loading .or-skeleton"),
    ).toHaveLength(10);
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
          timezone="Asia/Jerusalem"
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
      attachments: [
        {
          id: "90000000-0000-4000-8000-000000000001",
          objectId: "91000000-0000-4000-8000-000000000001",
          visitId: null,
          reportRevisionId: "30000000-0000-4000-8000-000000000001",
          category: "fault",
          source: "technician",
          processingStatus: "available",
          contentType: "image/png",
          byteSize: 68,
          caption: "צילום תקלה ישן",
          createdAt: "2026-09-14T09:00:00.000Z",
        },
      ],
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
    expect(screen.getByText("ראיות שלא נקלטו")).toBeTruthy();
    expect(screen.getByText("צילום תקלה ישן")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "צילום תקלה ישן" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "הורדת Excel" }).getAttribute("href"),
    ).toBe(
      "/api/field-service/reports/30000000-0000-4000-8000-000000000001/export?format=xlsx",
    );
    expect(screen.getByRole("button", { name: "מחיקת דוח" })).toBeTruthy();
    expect(screen.queryByText(/Brimag|Pro Touch/iu)).toBeNull();
  });
});
