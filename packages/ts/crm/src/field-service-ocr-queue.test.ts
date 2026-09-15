import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { listServiceOcrQueuePage } from "./field-service.js";

const ocrResultId = "10000000-0000-4000-8000-000000000001";
const attachmentId = "20000000-0000-4000-8000-000000000001";
const objectId = "30000000-0000-4000-8000-000000000001";
const caseId = "40000000-0000-4000-8000-000000000001";
const cursorId = "50000000-0000-4000-8000-000000000001";

function transaction(results: readonly unknown[][]) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const execute = vi.fn(
    (parts: TemplateStringsArray, ...parameters: unknown[]) => {
      statements.push(parts.join("?"));
      values.push(parameters);
      return Promise.resolve(results[statements.length - 1] ?? []);
    },
  );
  return {
    sql: execute as unknown as postgres.TransactionSql,
    statements,
    values,
  };
}

describe("field-service OCR review queue", () => {
  it("returns an exact-count, filtered latest-attempt page with a keyset cursor", async () => {
    const createdAt = new Date("2026-09-15T07:30:00.000Z");
    const completedAt = new Date("2026-09-15T07:31:00.000Z");
    const fixture = transaction([
      [{ available: true, enabled: true }],
      [
        {
          all_count: 7,
          attention_count: 3,
          in_flight_count: 2,
          completed_count: 2,
        },
      ],
      [
        {
          id: ocrResultId,
          attachment_id: attachmentId,
          object_id: objectId,
          case_id: caseId,
          case_reference: "FS-2026-0042",
          case_title: "Synthetic cooling fault",
          customer_name: "Fictional Customer",
          service_location_name: "Synthetic Store",
          category: "product_label",
          source: "technician",
          attachment_processing_status: "available",
          evidence_status: "available",
          content_type: "image/jpeg",
          status: "review_required",
          proposed_fields: {
            productModel: "MODEL-42",
            serialNumber: "SERIAL-0042",
          },
          confirmed_fields: { productType: "Refrigerator" },
          manually_confirmed_fields: ["productType"],
          confidence: "0.73",
          provider: "synthetic-ocr",
          model: "fixture-v1",
          provenance: { sourceObjectId: objectId, extractionVersion: 1 },
          error_safe: null,
          attempt: 2,
          created_at: createdAt,
          completed_at: completedAt,
          sort_priority: 0,
        },
        {
          id: "10000000-0000-4000-8000-000000000002",
          attachment_id: "20000000-0000-4000-8000-000000000002",
          object_id: "30000000-0000-4000-8000-000000000002",
          case_id: "40000000-0000-4000-8000-000000000002",
          case_reference: "FS-2026-0041",
          case_title: "Older synthetic fault",
          customer_name: "Fictional Customer",
          service_location_name: null,
          category: "product_label",
          source: "technician",
          attachment_processing_status: "available",
          evidence_status: "available",
          content_type: "image/jpeg",
          status: "failed",
          proposed_fields: {},
          confirmed_fields: {},
          manually_confirmed_fields: [],
          confidence: null,
          provider: null,
          model: null,
          provenance: {},
          error_safe: "Extraction failed",
          attempt: 1,
          created_at: new Date("2026-09-15T07:00:00.000Z"),
          completed_at: null,
          sort_priority: 1,
        },
      ],
    ]);

    await expect(
      listServiceOcrQueuePage(fixture.sql, {
        view: "attention",
        query: " MODEL-42 ",
        limit: 1,
        cursor: {
          status: "review_required",
          createdAt: "2026-09-15T08:00:00.000Z",
          id: cursorId,
        },
      }),
    ).resolves.toEqual({
      counts: { all: 7, attention: 3, inFlight: 2, completed: 2 },
      items: [
        {
          id: ocrResultId,
          attachmentId,
          objectId,
          caseId,
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
          confirmedFields: { productType: "Refrigerator" },
          manuallyConfirmedFields: ["productType"],
          confidence: 0.73,
          provider: "synthetic-ocr",
          model: "fixture-v1",
          provenance: { sourceObjectId: objectId, extractionVersion: 1 },
          errorSafe: null,
          attempt: 2,
          createdAt: createdAt.toISOString(),
          completedAt: completedAt.toISOString(),
        },
      ],
      nextCursor: {
        status: "review_required",
        createdAt: createdAt.toISOString(),
        id: ocrResultId,
      },
    });

    const countStatement = fixture.statements[1] ?? "";
    const pageStatement = fixture.statements[2] ?? "";
    expect(countStatement).toContain("count(*)::int AS all_count");
    expect(countStatement).toContain(
      "WHERE result.tenant_id=platform.current_tenant_id()",
    );
    expect(pageStatement).toContain("attachment.tenant_id=result.tenant_id");
    expect(pageStatement).toContain(
      "service_case.tenant_id=attachment.tenant_id",
    );
    expect(pageStatement).toContain("object.tenant_id=attachment.tenant_id");
    expect(pageStatement).toContain("max(latest.attempt)");
    expect(pageStatement).toContain("parameters.selected_view='attention'");
    expect(pageStatement).toContain("visible_results.sort_priority > CASE");
    expect(pageStatement).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/u);
    expect(fixture.values[1]).toEqual(["MODEL-42"]);
    expect(fixture.values[2]).toEqual([
      "MODEL-42",
      "attention",
      "review_required",
      "2026-09-15T08:00:00.000Z",
      cursorId,
      2,
    ]);
  });

  it("rejects an unsafe page limit before reading tenant data", async () => {
    const fixture = transaction([]);

    await expect(
      listServiceOcrQueuePage(fixture.sql, { limit: 501 }),
    ).rejects.toThrow("OCR queue limit is out of range");
    await expect(
      listServiceOcrQueuePage(fixture.sql, {
        cursor: {
          status: "confirmed",
          createdAt: "not-a-date",
          id: cursorId,
        },
      }),
    ).rejects.toThrow("OCR queue cursor timestamp is invalid");
    expect(fixture.statements).toHaveLength(0);
  });
});
