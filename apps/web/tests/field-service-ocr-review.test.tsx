import type { FieldServiceFeatureState, ServiceOcrQueueItem } from "@or-on/crm";
import { describe, expect, it } from "vitest";

import { OcrReviewWorkspace } from "../src/features/field-service";
import { renderMarkup } from "./localized";

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

const reviewItem: ServiceOcrQueueItem = {
  id: "10000000-0000-4000-8000-000000000001",
  attachmentId: "20000000-0000-4000-8000-000000000001",
  objectId: "30000000-0000-4000-8000-000000000001",
  caseId: "40000000-0000-4000-8000-000000000001",
  caseReference: "FS-2026-0042",
  caseTitle: "Synthetic cooling fault",
  customerName: "Fictional Customer",
  serviceLocationName: "Synthetic Store",
  category: "product_label",
  source: "technician",
  attachmentProcessingStatus: "available",
  evidenceStatus: "available",
  contentType: "image/jpeg",
  status: "review_required",
  proposedFields: {
    productModel: "MODEL-42",
    serialNumber: "SERIAL-0042",
  },
  confirmedFields: {},
  manuallyConfirmedFields: [],
  confidence: 0.73,
  provider: "synthetic-ocr",
  model: "fixture-v1",
  provenance: { extractionVersion: 1 },
  errorSafe: null,
  attempt: 1,
  createdAt: "2026-09-15T07:30:00.000Z",
  completedAt: "2026-09-15T07:31:00.000Z",
};

const initialPage = {
  items: [reviewItem],
  counts: { all: 7, attention: 3, inFlight: 2, completed: 2 },
  nextCursor: {
    status: reviewItem.status,
    createdAt: reviewItem.createdAt,
    id: reviewItem.id,
  },
} as const;

describe("field-service OCR review workspace", () => {
  it("renders actionable provenance and trusted case/evidence destinations", () => {
    const markup = renderMarkup(
      <OcrReviewWorkspace
        canOperate
        feature={feature}
        initialPage={initialPage}
        timezone="Asia/Jerusalem"
      />,
    );

    expect(markup).toContain("OCR review");
    expect(markup).toContain("Review required");
    expect(markup).toContain("synthetic-ocr");
    expect(markup).toContain("MODEL-42");
    expect(markup).toContain(
      `href="/field-service/cases/${reviewItem.caseId}"`,
    );
    expect(markup).toContain(
      `href="/api/field-service/attachments/${reviewItem.objectId}"`,
    );
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).not.toContain('role="tab"');
    expect(markup).not.toContain('role="tablist"');
    expect(markup).toContain("Showing 1 of 3");
    expect(markup).toContain("Load more results");
  });

  it("renders Hebrew operator copy and an honest disabled-integration notice", () => {
    const markup = renderMarkup(
      <OcrReviewWorkspace
        canOperate={false}
        feature={{ ...feature, ocrEnabled: false }}
        initialPage={initialPage}
        timezone="Asia/Jerusalem"
      />,
      "he",
    );

    expect(markup).toContain("בקרת OCR");
    expect(markup).toContain("נדרשת בדיקה");
    expect(markup).toContain("OCR אופציונלי כבוי");
    expect(markup).toContain("פתיחת התיק");
    expect(markup).toContain('dir="auto"');
  });
});
