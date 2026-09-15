import { deflateRawSync } from "node:zlib";

import type { ServiceReportDocument } from "./field-service.js";

export interface SafeZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array | string;
  readonly modifiedAt?: Date;
}

export interface SafeZipLimits {
  readonly maximumEntries?: number;
  readonly maximumUncompressedBytes?: number;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = (crcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function uint16(value: number): Buffer {
  const result = Buffer.allocUnsafe(2);
  result.writeUInt16LE(value, 0);
  return result;
}

function uint32(value: number): Buffer {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32LE(value >>> 0, 0);
  return result;
}

function dosDateTime(value: Date | undefined): {
  readonly day: number;
  readonly time: number;
} {
  const supplied = value ?? new Date(0);
  const date = Number.isNaN(supplied.valueOf()) ? new Date(0) : supplied;
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return {
    day:
      ((year - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
  };
}

function archivePath(value: string): string {
  const normalized = value.normalize("NFKC").replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.length > 500 ||
    normalized.startsWith("/") ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        /[<>:"|?*\p{Cc}]/u.test(segment),
    )
  )
    throw new TypeError("Archive entry path is invalid");
  return normalized;
}

export function safeArchiveSegment(value: string, fallback = "record"): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, "_")
    .replace(/\s+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 100);
  return normalized || fallback;
}

/**
 * Creates a bounded UTF-8 ZIP archive without shelling out or accepting
 * caller-controlled traversal paths. ZIP64 is intentionally unsupported so
 * the limits remain easy to reason about at the HTTP boundary.
 */
export function createSafeZipArchive(
  entries: readonly SafeZipEntry[],
  limits: SafeZipLimits = {},
): Buffer {
  const maximumEntries = limits.maximumEntries ?? 250;
  const maximumUncompressedBytes =
    limits.maximumUncompressedBytes ?? 250 * 1024 * 1024;
  if (entries.length === 0) throw new TypeError("Archive has no entries");
  if (
    entries.length > maximumEntries ||
    entries.length > 0xffff ||
    maximumEntries < 1
  )
    throw new TypeError("Archive contains too many entries");

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const names = new Set<string>();
  let offset = 0;
  let uncompressedBytes = 0;

  for (const entry of entries) {
    const path = archivePath(entry.path);
    if (names.has(path))
      throw new TypeError("Archive contains duplicate paths");
    names.add(path);
    const name = Buffer.from(path, "utf8");
    if (name.byteLength > 0xffff)
      throw new TypeError("Archive entry path is too long");
    const content =
      typeof entry.bytes === "string"
        ? Buffer.from(entry.bytes, "utf8")
        : Buffer.from(entry.bytes);
    uncompressedBytes += content.byteLength;
    if (
      uncompressedBytes > maximumUncompressedBytes ||
      content.byteLength > 0xffffffff
    )
      throw new TypeError("Archive exceeds the safe size limit");

    const compressed = deflateRawSync(content, { level: 6 });
    const checksum = crc32(content);
    const { day, time } = dosDateTime(entry.modifiedAt);
    const flags = 0x0800;
    const method = 8;
    const localHeader = Buffer.concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(flags),
      uint16(method),
      uint16(time),
      uint16(day),
      uint32(checksum),
      uint32(compressed.byteLength),
      uint32(content.byteLength),
      uint16(name.byteLength),
      uint16(0),
      name,
    ]);
    localParts.push(localHeader, compressed);

    centralParts.push(
      Buffer.concat([
        uint32(0x02014b50),
        uint16(20),
        uint16(20),
        uint16(flags),
        uint16(method),
        uint16(time),
        uint16(day),
        uint32(checksum),
        uint32(compressed.byteLength),
        uint32(content.byteLength),
        uint16(name.byteLength),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(0),
        uint32(offset),
        name,
      ]),
    );
    offset += localHeader.byteLength + compressed.byteLength;
    if (offset > 0xffffffff)
      throw new TypeError("Archive exceeds the ZIP32 size limit");
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.byteLength > 0xffffffff)
    throw new TypeError("Archive directory exceeds the ZIP32 size limit");
  return Buffer.concat([
    ...localParts,
    centralDirectory,
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(centralDirectory.byteLength),
    uint32(offset),
    uint16(0),
  ]);
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cell(
  reference: string,
  value: string | number | boolean | null,
  style: number,
): string {
  const text = Array.from(value === null ? "—" : String(value))
    .slice(0, 32_767)
    .join("");
  return `<c r="${reference}" s="${String(style)}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}

function snapshotValue(
  snapshot: Readonly<Record<string, unknown>>,
  key: string,
  fallback: string | null,
): string | null {
  const value = snapshot[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : fallback;
}

function attendanceName(
  identity: Readonly<Record<string, unknown>> | null,
): string | null {
  const value = identity?.fullName;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function formattedDate(
  value: string | null,
  locale: string,
  timezone: string,
): string | null {
  if (value === null) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
}

const workbookAccent: Readonly<Record<string, string>> = {
  amber: "B45309",
  blue: "155CFF",
  cyan: "0E7490",
  emerald: "047857",
  rose: "BE123C",
  violet: "6D28D9",
};

/** Produces a real XLSX workbook from an immutable signed-report snapshot. */
export function createServiceReportWorkbook(
  report: ServiceReportDocument,
): Buffer {
  if (
    report.revision.status !== "finalized" &&
    report.revision.status !== "superseded"
  )
    throw new TypeError("Only an immutable signed report can be exported");
  const he = report.branding.locale.toLowerCase().startsWith("he");
  const labels = he
    ? {
        reference: "מספר קריאה",
        customer: "לקוח",
        nationalId: "מספר מזהה (מוסתר)",
        location: "מיקום שירות",
        address: "כתובת",
        technician: "טכנאי",
        employeeId: "מזהה טכנאי",
        arrival: "הגעה",
        departure: "יציאה",
        duration: "משך ביקור בדקות",
        fault: "תיאור התקלה",
        warranty: "אחריות",
        product: "מוצר",
        model: "דגם",
        serial: "מספר סידורי",
        diagnosis: "אבחון",
        work: "עבודה שבוצעה",
        partReplaced: "הוחלף חלק",
        partDetails: "פרטי החלק",
        notes: "הערות טכנאי",
        attachments: "מספר קבצים מצורפים",
        finalized: "מועד סיום",
      }
    : {
        reference: "Case reference",
        customer: "Customer",
        nationalId: "National ID (masked)",
        location: "Service location",
        address: "Address",
        technician: "Technician",
        employeeId: "Technician identifier",
        arrival: "Arrival",
        departure: "Departure",
        duration: "Visit duration (minutes)",
        fault: "Reported fault",
        warranty: "Warranty",
        product: "Product",
        model: "Model",
        serial: "Serial number",
        diagnosis: "Diagnosis",
        work: "Work performed",
        partReplaced: "Part replaced",
        partDetails: "Replacement part details",
        notes: "Technician notes",
        attachments: "Attachment count",
        finalized: "Finalized",
      };
  const locale = report.branding.locale;
  const timezone = report.branding.timezone;
  const warranty =
    report.serviceCase.warrantyStatus === "unknown"
      ? he
        ? "לא ידוע"
        : "Unknown"
      : report.serviceCase.warrantyStatus === "yes"
        ? he
          ? "כן"
          : "Yes"
        : he
          ? "לא"
          : "No";
  const rows: readonly (readonly [string, string | number | boolean | null])[] =
    [
      [labels.reference, report.serviceCase.reference],
      [labels.customer, report.serviceCase.customerName],
      [labels.nationalId, report.customer.nationalIdMasked],
      [labels.location, report.serviceCase.serviceLocationName],
      [labels.address, report.serviceCase.serviceLocationAddress],
      [labels.technician, report.technician.fullName],
      [labels.employeeId, report.technician.employeeIdentifier],
      [
        labels.arrival,
        `${attendanceName(report.visit.arrivalIdentity) ?? "—"} · ${formattedDate(report.visit.arrivalAt, locale, timezone) ?? "—"}`,
      ],
      [
        labels.departure,
        `${attendanceName(report.visit.departureIdentity) ?? "—"} · ${formattedDate(report.visit.departureAt, locale, timezone) ?? "—"}`,
      ],
      [
        labels.duration,
        report.visit.durationSeconds === null
          ? null
          : Math.floor(report.visit.durationSeconds / 60),
      ],
      [labels.fault, report.serviceCase.faultDescription],
      [labels.warranty, warranty],
      [
        labels.product,
        snapshotValue(
          report.productSnapshot,
          "type",
          report.serviceCase.productType,
        ),
      ],
      [
        labels.model,
        snapshotValue(
          report.productSnapshot,
          "model",
          report.serviceCase.productModel,
        ),
      ],
      [
        labels.serial,
        snapshotValue(
          report.productSnapshot,
          "serialNumber",
          report.serviceCase.serialNumber,
        ),
      ],
      [labels.diagnosis, report.revision.diagnosis],
      [labels.work, report.revision.workPerformed],
      [
        labels.partReplaced,
        report.revision.partReplaced === null
          ? null
          : report.revision.partReplaced
            ? he
              ? "כן"
              : "Yes"
            : he
              ? "לא"
              : "No",
      ],
      [labels.partDetails, report.revision.replacementPartDetails],
      [labels.notes, report.revision.technicianNotes],
      [labels.attachments, report.attachments.length],
      [
        labels.finalized,
        formattedDate(report.revision.finalizedAt, locale, timezone),
      ],
    ];
  const body = rows
    .map(
      ([label, value], index) =>
        `<row r="${String(index + 3)}">${cell(`A${String(index + 3)}`, label, 2)}${cell(`B${String(index + 3)}`, value, 3)}</row>`,
    )
    .join("");
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"${he ? ' rightToLeft="1"' : ""}/></sheetViews><cols><col min="1" max="1" width="26" customWidth="1"/><col min="2" max="2" width="72" customWidth="1"/></cols><sheetData><row r="1" ht="28" customHeight="1">${cell("A1", report.branding.businessName, 1)}</row><row r="2">${cell("A2", report.branding.reportHeader, 3)}</row>${body}</sheetData><mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="A2:B2"/></mergeCells></worksheet>`;
  const accent =
    workbookAccent[report.branding.accentToken ?? "blue"] ??
    workbookAccent.blue ??
    "155CFF";
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="16"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF${accent}"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const sheetName = xml(he ? "דוח שירות" : "Service report");
  const modifiedAt =
    report.revision.finalizedAt === null
      ? new Date(0)
      : new Date(report.revision.finalizedAt);
  return createSafeZipArchive(
    [
      {
        path: "[Content_Types].xml",
        bytes: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
        modifiedAt,
      },
      {
        path: "_rels/.rels",
        bytes: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        modifiedAt,
      },
      {
        path: "xl/workbook.xml",
        bytes: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        modifiedAt,
      },
      {
        path: "xl/_rels/workbook.xml.rels",
        bytes: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        modifiedAt,
      },
      { path: "xl/worksheets/sheet1.xml", bytes: worksheet, modifiedAt },
      { path: "xl/styles.xml", bytes: styles, modifiedAt },
    ],
    { maximumEntries: 10, maximumUncompressedBytes: 2 * 1024 * 1024 },
  );
}
