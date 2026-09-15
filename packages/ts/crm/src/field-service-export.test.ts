import { inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { ServiceReportDocument } from "./field-service.js";
import {
  createSafeZipArchive,
  createServiceReportWorkbook,
} from "./field-service-export.js";

function zipEntries(bytes: Buffer): ReadonlyMap<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameSize + extraSize;
    const name = bytes
      .subarray(nameStart, nameStart + nameSize)
      .toString("utf8");
    const compressed = bytes.subarray(
      contentStart,
      contentStart + compressedSize,
    );
    entries.set(
      name,
      method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed),
    );
    offset = contentStart + compressedSize;
  }
  return entries;
}

const report = {
  revision: {
    id: "10000000-0000-4000-8000-000000000001",
    reportId: "10000000-0000-4000-8000-000000000002",
    version: 1,
    status: "finalized",
    diagnosis: "כשל בלוח הבקרה",
    workPerformed: "הוחלף ונבדק",
    partReplaced: true,
    replacementPartDetails: "CTRL-42",
    technicianNotes: "תקין",
    finalizedAt: "2026-09-14T10:00:00.000Z",
  },
  serviceCase: {
    id: "20000000-0000-4000-8000-000000000001",
    reference: "FS-2026-0001",
    customerContactId: "30000000-0000-4000-8000-000000000001",
    customerName: "לקוח לדוגמה",
    serviceLocationId: null,
    serviceLocationName: "חנות מרכזית",
    serviceLocationAddress: "רחוב הדוגמה 1",
    status: "completed",
    title: "תקלה",
    faultDescription: '=WEBSERVICE("https://unsafe.example")',
    warrantyStatus: "yes",
    productType: "מקרר",
    productModel: "MODEL-42",
    serialNumber: "000123",
    priority: "normal",
    createdAt: "2026-09-14T07:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
  },
  customer: {
    contactId: "30000000-0000-4000-8000-000000000001",
    nationalIdMasked: "••••••0123",
    preferredLanguage: "he",
    address: "רחוב הדוגמה 1",
    classifications: [],
    locations: [],
    documents: [],
  },
  visit: {
    id: "40000000-0000-4000-8000-000000000001",
    caseId: "20000000-0000-4000-8000-000000000001",
    appointmentId: null,
    technicianId: "50000000-0000-4000-8000-000000000001",
    visitNumber: 1,
    status: "reported",
    arrivalAt: "2026-09-14T08:00:00.000Z",
    departureAt: "2026-09-14T09:00:00.000Z",
    durationSeconds: 3600,
    arrivalSignatureObjectId: "60000000-0000-4000-8000-000000000001",
    departureSignatureObjectId: "60000000-0000-4000-8000-000000000002",
    arrivalIdentity: { fullName: "דנה הטכנאית" },
    departureIdentity: { fullName: "דנה הטכנאית" },
  },
  technician: {
    id: "50000000-0000-4000-8000-000000000001",
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
    reportHeader: "שירות מקצועי",
    reportFooter: "תודה שבחרתם בנו",
    businessEmail: "service@example.test",
    businessPhone: "+97230000000",
    businessAddress: "רחוב הדוגמה 1",
    locale: "he-IL",
    timezone: "Asia/Jerusalem",
  },
  attachments: [],
} satisfies ServiceReportDocument;

describe("field-service export artifacts", () => {
  it("creates a bounded UTF-8 ZIP and rejects unsafe paths", () => {
    const archive = createSafeZipArchive([
      { path: "Evidence/צילום-תקלה.txt", bytes: "verified" },
    ]);
    expect(zipEntries(archive).get("Evidence/צילום-תקלה.txt")?.toString()).toBe(
      "verified",
    );
    expect(() =>
      createSafeZipArchive([{ path: "../secret.txt", bytes: "no" }]),
    ).toThrow("path is invalid");
  });

  it("rejects duplicate paths and archives over their declared bound", () => {
    expect(() =>
      createSafeZipArchive([
        { path: "same.txt", bytes: "one" },
        { path: "same.txt", bytes: "two" },
      ]),
    ).toThrow("duplicate paths");
    expect(() =>
      createSafeZipArchive([{ path: "large.txt", bytes: "12345" }], {
        maximumUncompressedBytes: 4,
      }),
    ).toThrow("safe size limit");
  });

  it("creates an RTL XLSX from the immutable report without executable formulas", () => {
    const workbook = zipEntries(createServiceReportWorkbook(report));
    expect(workbook.has("[Content_Types].xml")).toBe(true);
    const sheet = workbook.get("xl/worksheets/sheet1.xml")?.toString("utf8");
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain("שירות הכוכב");
    expect(sheet).toContain("••••••0123");
    expect(sheet).toContain("=WEBSERVICE");
    expect(sheet).not.toContain("<f>");
  });

  it("keeps a superseded signed revision exportable", () => {
    const workbook = createServiceReportWorkbook({
      ...report,
      revision: { ...report.revision, status: "superseded" },
    });

    expect(zipEntries(workbook).has("[Content_Types].xml")).toBe(true);
  });

  it("does not export a mutable report draft", () => {
    expect(() =>
      createServiceReportWorkbook({
        ...report,
        revision: { ...report.revision, status: "draft" },
      }),
    ).toThrow("immutable signed report");
  });
});
