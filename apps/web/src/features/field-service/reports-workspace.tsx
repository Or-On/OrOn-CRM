"use client";

import type {
  ServiceReportCursor,
  ServiceReportPage,
  ServiceReportStatus,
} from "@or-on/crm";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Input,
  Select,
  Surface,
} from "@or-on/ui";
import { ArrowLeft, ChevronRight, FileCheck2, Search } from "lucide-react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";

import { crmRead } from "../crm";
import { reportStatusLabel } from "./field-service-labels";
import { FieldServiceNavigation } from "./field-service-navigation";

function reportTone(status: ServiceReportStatus) {
  if (status === "finalized") return "positive" as const;
  if (status === "review_required") return "warning" as const;
  if (status === "superseded") return "neutral" as const;
  return "info" as const;
}

function isImmutableReport(status: ServiceReportStatus): boolean {
  return status === "finalized" || status === "superseded";
}

function reportParameters(
  query: string,
  status: ServiceReportStatus | "",
  cursor?: ServiceReportCursor,
) {
  const parameters = new URLSearchParams({ limit: "50" });
  const trimmed = query.trim();
  if (trimmed !== "") parameters.set("q", trimmed);
  if (status !== "") parameters.set("status", status);
  if (cursor !== undefined) {
    parameters.set("cursorAt", cursor.updatedAt);
    parameters.set("cursorId", cursor.id);
  }
  return parameters;
}

export function ReportsWorkspace({
  initialPage,
  timezone,
}: {
  readonly initialPage: ServiceReportPage;
  readonly timezone: string;
}) {
  const locale = useLocale();
  const he = locale.startsWith("he");
  const [reports, setReports] = useState(initialPage.reports);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [status, setStatus] = useState<ServiceReportStatus | "">("");
  const [appliedStatus, setAppliedStatus] = useState<ServiceReportStatus | "">(
    "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );

  async function load(options: {
    readonly append: boolean;
    readonly query?: string;
    readonly status?: ServiceReportStatus | "";
  }) {
    const selectedQuery =
      options.query ?? (options.append ? appliedQuery : query);
    const selectedStatus =
      options.status ?? (options.append ? appliedStatus : status);
    const cursor = options.append ? (nextCursor ?? undefined) : undefined;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(undefined);
    try {
      const page = await crmRead<ServiceReportPage>(
        `/api/field-service/reports?${reportParameters(selectedQuery, selectedStatus, cursor).toString()}`,
        controller.signal,
      );
      setReports((current) =>
        options.append ? [...current, ...page.reports] : page.reports,
      );
      setNextCursor(page.nextCursor);
      if (!options.append) {
        setAppliedQuery(selectedQuery);
        setAppliedStatus(selectedStatus);
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof Error
          ? cause.message
          : he
            ? "לא ניתן לטעון את הדוחות."
            : "Reports could not be loaded.",
      );
    } finally {
      if (request.current === controller) setPending(false);
    }
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    void load({ append: false });
  }

  function clearFilters() {
    setQuery("");
    setStatus("");
    void load({ append: false, query: "", status: "" });
  }

  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  });

  return (
    <div className="field-service-workspace field-service-reports-workspace">
      <Link className="service-case-back" href="/field-service">
        <ArrowLeft aria-hidden="true" size={16} />
        {he ? "חזרה לשירות השטח" : "Back to field service"}
      </Link>

      <header className="platform-admin-hero field-service-hero">
        <div className="platform-admin-hero__copy">
          <span className="eyebrow">
            {he ? "היסטוריית שירות" : "Service history"}
          </span>
          <h1>{he ? "דוחות טכנאים" : "Technician reports"}</h1>
          <p>
            {he
              ? "כל טיוטה, בדיקה ודוח חתום נשמרים לפי תיק וביקור, בלי לאבד גרסאות קודמות."
              : "Review every draft, approval state, and signed revision by case and visit without losing earlier versions."}
          </p>
        </div>
      </header>

      <FieldServiceNavigation active="reports" />

      <form
        className="field-service-report-filters"
        onSubmit={submit}
        role="search"
      >
        <Input
          id="service-report-search"
          label={he ? "חיפוש דוחות" : "Search reports"}
          name="q"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            he
              ? "לקוח, טכנאי, תיק או נושא…"
              : "Customer, technician, case, or subject…"
          }
          type="search"
          value={query}
        />
        <Select
          id="service-report-status"
          label={he ? "סטטוס" : "Status"}
          name="status"
          onChange={(event) =>
            setStatus(event.target.value as ServiceReportStatus | "")
          }
          value={status}
        >
          <option value="">{he ? "כל הסטטוסים" : "All statuses"}</option>
          <option value="draft">{reportStatusLabel("draft", he)}</option>
          <option value="review_required">
            {reportStatusLabel("review_required", he)}
          </option>
          <option value="finalized">
            {reportStatusLabel("finalized", he)}
          </option>
          <option value="superseded">
            {reportStatusLabel("superseded", he)}
          </option>
        </Select>
        <div className="field-service-report-filter-actions">
          {(query !== "" || status !== "") && (
            <Button onClick={clearFilters} type="button" variant="quiet">
              {he ? "ניקוי" : "Clear"}
            </Button>
          )}
          <Button busy={pending} type="submit" variant="secondary">
            <Search aria-hidden="true" size={15} />
            {he ? "חיפוש" : "Search"}
          </Button>
        </div>
      </form>

      {error === undefined ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {reports.length === 0 ? (
        <EmptyState
          action={
            query === "" && status === "" ? undefined : (
              <Button onClick={clearFilters} type="button" variant="secondary">
                {he ? "הצגת כל הדוחות" : "Show all reports"}
              </Button>
            )
          }
          description={
            query === "" && status === ""
              ? he
                ? "דוחות יופיעו כאן לאחר פתיחת דוח בביקור שירות."
                : "Reports will appear here after a report is opened for a service visit."
              : he
                ? "לא נמצאו דוחות התואמים למסננים."
                : "No reports match these filters."
          }
          title={he ? "אין דוחות להצגה" : "No reports to show"}
        />
      ) : (
        <Surface
          aria-busy={pending}
          className="field-service-directory field-service-report-directory"
          level="raised"
        >
          <DataTable
            label={he ? "דוחות טכנאים" : "Technician reports"}
            minWidth="68rem"
          >
            <thead>
              <tr>
                <th>{he ? "דוח" : "Report"}</th>
                <th>{he ? "תיק ולקוח" : "Case & customer"}</th>
                <th>{he ? "ביקור וטכנאי" : "Visit & technician"}</th>
                <th>{he ? "סטטוס" : "Status"}</th>
                <th>{he ? "עודכן" : "Updated"}</th>
                <th>
                  <span className="or-visually-hidden">
                    {he ? "פעולות" : "Actions"}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => {
                const immutable = isImmutableReport(report.status);
                const destination = immutable
                  ? `/field-service/reports/${report.id}`
                  : `/field-service/cases/${report.caseId}`;
                return (
                  <tr key={report.id}>
                    <td>
                      <Link
                        className="field-service-case-link"
                        href={destination}
                      >
                        <strong>
                          <FileCheck2 aria-hidden="true" size={14} />
                          {he ? "גרסה" : "Version"} {report.version}
                        </strong>
                        <small dir="ltr">{report.id.slice(0, 8)}</small>
                      </Link>
                    </td>
                    <td>
                      <Link
                        className="field-service-case-link"
                        href={`/field-service/cases/${report.caseId}`}
                      >
                        <strong dir="ltr">{report.caseReference}</strong>
                        <small>
                          <bdi dir="auto">{report.customerName}</bdi>
                          <span aria-hidden="true">·</span>
                          <bdi dir="auto">{report.caseTitle}</bdi>
                        </small>
                      </Link>
                    </td>
                    <td>
                      <strong>
                        {he ? "ביקור" : "Visit"} {report.visitNumber}
                      </strong>
                      <small dir="auto">{report.technicianName}</small>
                    </td>
                    <td>
                      <Badge
                        label={reportStatusLabel(report.status, he)}
                        tone={reportTone(report.status)}
                      />
                    </td>
                    <td data-label={he ? "עודכן" : "Updated"}>
                      <time dateTime={report.updatedAt}>
                        {date.format(new Date(report.updatedAt))}
                      </time>
                      {report.finalizedAt === null ? null : (
                        <small>
                          {he ? "נחתם" : "Signed"}{" "}
                          <time dateTime={report.finalizedAt}>
                            {date.format(new Date(report.finalizedAt))}
                          </time>
                        </small>
                      )}
                    </td>
                    <td>
                      <div className="field-service-row-actions">
                        <Link
                          aria-label={
                            immutable
                              ? he
                                ? `פתיחת דוח ${report.caseReference}, גרסה ${String(report.version)}`
                                : `Open report ${report.caseReference}, version ${String(report.version)}`
                              : he
                                ? `פתיחת תיק ${report.caseReference}`
                                : `Open case ${report.caseReference}`
                          }
                          href={destination}
                        >
                          <ChevronRight aria-hidden="true" size={17} />
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </Surface>
      )}

      {nextCursor === null ? null : (
        <div className="field-service-load-more">
          <Button
            busy={pending}
            disabled={pending}
            onClick={() => void load({ append: true })}
            variant="secondary"
          >
            {he ? "טעינת דוחות קודמים" : "Load older reports"}
          </Button>
        </div>
      )}
    </div>
  );
}
