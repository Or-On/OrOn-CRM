import Image from "next/image";
import { notFound, redirect } from "next/navigation";

import { getServiceReportDocument } from "@or-on/crm";

import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../../../features/auth";
import { ReportActions } from "../../../../features/field-service";
import { AccessDenied } from "../../../../i18n/access-denied";

function snapshotText(
  value: Readonly<Record<string, unknown>>,
  key: string,
  fallback = "—",
) {
  const selected = value[key];
  return typeof selected === "string" && selected.trim() !== ""
    ? selected
    : fallback;
}

function attendanceName(value: Readonly<Record<string, unknown>> | null) {
  const name = value?.fullName;
  return typeof name === "string" && name.trim() !== "" ? name : "—";
}

const imageCategories = new Set([
  "fault",
  "module",
  "product_label",
  "repair",
  "environment",
  "customer_photo",
  "arrival_signature",
  "departure_signature",
]);
const legacyBlankPngByteSize = 68;

export default async function ServiceReportPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  try {
    const { id } = await params;
    const report = await withCurrentTenant("field-service:read", (sql) =>
      getServiceReportDocument(sql, id),
    );
    if (report === undefined) notFound();
    const he = report.branding.locale.startsWith("he");
    const date = new Intl.DateTimeFormat(report.branding.locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: report.branding.timezone,
    });
    const logoMime = report.branding.logoContentType;
    const logoSource =
      report.branding.logoData !== null &&
      logoMime !== null &&
      ["image/png", "image/jpeg", "image/webp"].includes(logoMime)
        ? `data:${logoMime};base64,${report.branding.logoData.replaceAll(/\s/gu, "")}`
        : null;
    const reportImages = report.attachments.filter(
      (attachment) =>
        attachment.processingStatus === "available" &&
        imageCategories.has(attachment.category) &&
        attachment.contentType.startsWith("image/"),
    );
    const invalidLegacyAttachments = reportImages.filter(
      (attachment) =>
        attachment.contentType === "image/png" &&
        attachment.byteSize <= legacyBlankPngByteSize,
    );
    const visibleAttachments = reportImages.filter(
      (attachment) => !invalidLegacyAttachments.includes(attachment),
    );
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
    return (
      <main
        className="page page--wide page--field-service-report"
        data-tenant-accent={report.branding.accentToken ?? undefined}
        dir={he ? "rtl" : "ltr"}
      >
        <ReportActions
          caseId={report.serviceCase.id}
          he={he}
          revisionId={report.revision.id}
        />
        <article className="service-report-document">
          <header className="service-report-document__header">
            <div className="service-report-document__identity">
              {logoSource === null ? (
                <span
                  aria-hidden="true"
                  className="service-report-document__logo-fallback"
                >
                  {report.branding.businessName.slice(0, 2).toLocaleUpperCase()}
                </span>
              ) : (
                <Image
                  alt=""
                  className="service-report-document__logo"
                  height={72}
                  src={logoSource}
                  unoptimized
                  width={72}
                />
              )}
              <div>
                <strong>{report.branding.businessName}</strong>
                {report.branding.reportHeader === null ? null : (
                  <p dir="auto">{report.branding.reportHeader}</p>
                )}
              </div>
            </div>
            <div className="service-report-document__reference">
              <span>{he ? "דוח שירות" : "Service report"}</span>
              <strong dir="ltr">{report.serviceCase.reference}</strong>
              <small>
                {he ? "גרסה" : "Version"} {report.revision.version}
              </small>
            </div>
          </header>

          <section className="service-report-document__facts">
            <div>
              <span>{he ? "לקוח" : "Customer"}</span>
              <strong dir="auto">{report.serviceCase.customerName}</strong>
              <small dir="ltr">{report.customer.nationalIdMasked ?? "—"}</small>
            </div>
            <div>
              <span>{he ? "מיקום שירות" : "Service location"}</span>
              <strong dir="auto">
                {report.serviceCase.serviceLocationName ?? "—"}
              </strong>
              <small dir="auto">
                {report.serviceCase.serviceLocationAddress ?? "—"}
              </small>
            </div>
            <div>
              <span>{he ? "טכנאי" : "Technician"}</span>
              <strong dir="auto">{report.technician.fullName}</strong>
              <small dir="ltr">
                {report.technician.employeeIdentifier ?? "—"}
              </small>
            </div>
            <div>
              <span>{he ? "מועד סיום" : "Finalized"}</span>
              <strong>
                {report.revision.finalizedAt === null
                  ? "—"
                  : date.format(new Date(report.revision.finalizedAt))}
              </strong>
              <small>{report.branding.timezone}</small>
            </div>
          </section>

          <section className="service-report-document__section">
            <h2>{he ? "פרטי הקריאה" : "Service case"}</h2>
            <dl className="service-report-document__grid">
              <div>
                <dt>{he ? "תיאור התקלה" : "Reported fault"}</dt>
                <dd dir="auto">{report.serviceCase.faultDescription}</dd>
              </div>
              <div>
                <dt>{he ? "אחריות" : "Warranty"}</dt>
                <dd>{warranty}</dd>
              </div>
              <div>
                <dt>{he ? "סוג מוצר" : "Product"}</dt>
                <dd dir="auto">
                  {snapshotText(
                    report.productSnapshot,
                    "type",
                    report.serviceCase.productType ?? "—",
                  )}
                </dd>
              </div>
              <div>
                <dt>{he ? "דגם" : "Model"}</dt>
                <dd dir="ltr">
                  {snapshotText(
                    report.productSnapshot,
                    "model",
                    report.serviceCase.productModel ?? "—",
                  )}
                </dd>
              </div>
              <div>
                <dt>{he ? "מספר סידורי" : "Serial number"}</dt>
                <dd dir="ltr">
                  {snapshotText(
                    report.productSnapshot,
                    "serialNumber",
                    report.serviceCase.serialNumber ?? "—",
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <section className="service-report-document__section">
            <h2>{he ? "אבחון ועבודה" : "Diagnosis & work"}</h2>
            <div className="service-report-document__narrative">
              <div>
                <h3>{he ? "אבחון" : "Diagnosis"}</h3>
                <p dir="auto">{report.revision.diagnosis}</p>
              </div>
              <div>
                <h3>{he ? "עבודה שבוצעה" : "Work performed"}</h3>
                <p dir="auto">{report.revision.workPerformed}</p>
              </div>
              <div>
                <h3>{he ? "החלפת חלק" : "Part replacement"}</h3>
                <p dir="auto">
                  {report.revision.partReplaced
                    ? report.revision.replacementPartDetails
                    : he
                      ? "לא הוחלף חלק"
                      : "No part replaced"}
                </p>
              </div>
            </div>
          </section>

          <section className="service-report-document__section">
            <h2>{he ? "נוכחות וחתימות" : "Attendance & signatures"}</h2>
            <div className="service-report-document__attendance">
              <div>
                <span>{he ? "הגעה" : "Arrival"}</span>
                <strong>{attendanceName(report.visit.arrivalIdentity)}</strong>
                <time dateTime={report.visit.arrivalAt ?? undefined}>
                  {report.visit.arrivalAt === null
                    ? "—"
                    : date.format(new Date(report.visit.arrivalAt))}
                </time>
              </div>
              <div>
                <span>{he ? "יציאה" : "Departure"}</span>
                <strong>
                  {attendanceName(report.visit.departureIdentity)}
                </strong>
                <time dateTime={report.visit.departureAt ?? undefined}>
                  {report.visit.departureAt === null
                    ? "—"
                    : date.format(new Date(report.visit.departureAt))}
                </time>
              </div>
              <div>
                <span>{he ? "משך ביקור" : "Visit duration"}</span>
                <strong>
                  {report.visit.durationSeconds === null
                    ? "—"
                    : `${String(Math.floor(report.visit.durationSeconds / 3600))}:${String(
                        Math.floor((report.visit.durationSeconds % 3600) / 60),
                      ).padStart(2, "0")}`}
                </strong>
              </div>
            </div>
          </section>

          {visibleAttachments.length === 0 ? null : (
            <section className="service-report-document__section">
              <h2>{he ? "ראיות מצורפות" : "Attached evidence"}</h2>
              <div className="service-report-document__evidence">
                {visibleAttachments.map((attachment) => (
                  <figure key={attachment.id}>
                    <Image
                      alt={
                        attachment.caption ??
                        attachment.category.replaceAll("_", " ")
                      }
                      height={260}
                      src={`/api/field-service/attachments/${attachment.objectId}`}
                      unoptimized
                      width={420}
                    />
                    <figcaption dir="auto">
                      {attachment.caption ??
                        attachment.category.replaceAll("_", " ")}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          )}

          {invalidLegacyAttachments.length === 0 ? null : (
            <section className="service-report-document__section">
              <h2>{he ? "ראיות שלא נקלטו" : "Evidence unavailable"}</h2>
              <div
                className="service-report-document__evidence-warning"
                role="status"
              >
                <strong>
                  {he
                    ? "הקבצים הישנים האלה ריקים ולא יוצגו כעמוד לבן."
                    : "These legacy files are empty and will not be shown as blank pages."}
                </strong>
                <p>
                  {he
                    ? "יש להעלות מחדש את תמונות הראיות מתוך תיק השירות."
                    : "Upload the evidence photos again from the service case."}
                </p>
                <ul>
                  {invalidLegacyAttachments.map((attachment) => (
                    <li key={attachment.id} dir="auto">
                      {attachment.caption ??
                        attachment.category.replaceAll("_", " ")}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <footer className="service-report-document__footer">
            <p dir="auto">{report.branding.reportFooter}</p>
            <address>
              {[
                report.branding.businessAddress,
                report.branding.businessPhone,
                report.branding.businessEmail,
              ]
                .filter((value): value is string => value !== null)
                .join(" · ")}
            </address>
          </footer>
        </article>
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const metadata = { title: "Field Service report" };
