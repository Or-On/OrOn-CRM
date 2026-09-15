"use client";

import type {
  FieldServiceFeatureState,
  ServiceOcrQueueItem,
  ServiceOcrQueuePage,
  ServiceOcrQueueView,
} from "@or-on/crm";
import {
  AnimatedNumber,
  Badge,
  EmptyState,
  InlineFeedback,
  Surface,
} from "@or-on/ui";
import {
  AlertTriangle,
  CircleCheckBig,
  Clock3,
  ExternalLink,
  FileImage,
  MapPin,
  ScanSearch,
  ScanText,
  Search,
} from "lucide-react";
import { useLocale } from "next-intl";
import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";

import { crmRead } from "../crm";
import {
  evidenceCategoryLabel,
  ocrStatusLabel,
  processingStatusLabel,
  readableFieldServiceValue,
} from "./field-service-labels";
import {
  ocrQueueParameters,
  ocrQueueViewCount,
  type OcrQueueView,
} from "./ocr-review-model";
import { FieldServiceNavigation } from "./field-service-navigation";

function statusTone(status: ServiceOcrQueueItem["status"]) {
  if (status === "confirmed") return "positive" as const;
  if (status === "review_required") return "warning" as const;
  if (status === "failed") return "critical" as const;
  if (status === "processing") return "info" as const;
  return "neutral" as const;
}

function fieldLabel(field: string, he: boolean): string {
  const labels: Readonly<Record<string, readonly [string, string]>> = {
    productType: ["Product type", "סוג מוצר"],
    productModel: ["Product model", "דגם מוצר"],
    serialNumber: ["Serial number", "מספר סידורי"],
  };
  const label = labels[field];
  return label === undefined
    ? readableFieldServiceValue(field)
    : label[he ? 1 : 0];
}

function sourceLabel(source: string, he: boolean): string {
  const labels: Readonly<Record<string, readonly [string, string]>> = {
    customer: ["Customer upload", "העלאת לקוח"],
    technician: ["Technician upload", "העלאת טכנאי"],
    operator: ["Operator upload", "העלאת מפעיל"],
    system: ["System evidence", "ראיית מערכת"],
  };
  return labels[source]?.[he ? 1 : 0] ?? readableFieldServiceValue(source);
}

export function OcrReviewWorkspace({
  feature,
  initialPage,
  timezone,
  canOperate,
}: {
  readonly feature: FieldServiceFeatureState;
  readonly initialPage: ServiceOcrQueuePage;
  readonly timezone: string;
  readonly canOperate: boolean;
}) {
  const locale = useLocale();
  const he = locale.startsWith("he");
  const [items, setItems] = useState(initialPage.items);
  const [counts, setCounts] = useState(initialPage.counts);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [view, setView] = useState<OcrQueueView>("attention");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
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
    readonly view?: ServiceOcrQueueView;
  }) {
    const selectedQuery = (options.query ?? appliedQuery).trim();
    const selectedView = options.view ?? view;
    const cursor = options.append ? (nextCursor ?? undefined) : undefined;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(undefined);
    try {
      const page = await crmRead<ServiceOcrQueuePage>(
        `/api/field-service/ocr?${ocrQueueParameters(selectedQuery, selectedView, cursor).toString()}`,
        controller.signal,
      );
      setItems((current) =>
        options.append ? [...current, ...page.items] : page.items,
      );
      setCounts(page.counts);
      setNextCursor(page.nextCursor);
      if (!options.append) {
        setAppliedQuery(selectedQuery);
        setView(selectedView);
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof Error
          ? cause.message
          : he
            ? "לא ניתן לטעון את תור ה-OCR."
            : "The OCR queue could not be loaded.",
      );
    } finally {
      if (request.current === controller) setPending(false);
    }
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    void load({ append: false, query });
  }

  const selectedTotal = ocrQueueViewCount(counts, view);
  const dateTime = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: timezone,
      }),
    [locale, timezone],
  );

  const tabs: readonly {
    readonly id: OcrQueueView;
    readonly label: string;
    readonly count: number;
  }[] = [
    {
      id: "attention",
      label: he ? "דורש טיפול" : "Needs attention",
      count: counts.attention,
    },
    {
      id: "in_flight",
      label: he ? "בתהליך" : "In progress",
      count: counts.inFlight,
    },
    {
      id: "completed",
      label: he ? "הושלם" : "Completed",
      count: counts.completed,
    },
    { id: "all", label: he ? "הכול" : "All", count: counts.all },
  ];

  return (
    <div
      aria-busy={pending}
      className="field-service-workspace field-service-ocr-workspace"
    >
      <header className="platform-admin-hero field-service-hero">
        <div className="platform-admin-hero__copy">
          <span className="eyebrow">
            {he ? "בקרת ראיות" : "Evidence operations"}
          </span>
          <h1>{he ? "בקרת OCR" : "OCR review"}</h1>
          <p>
            {he
              ? "בודקים חילוץ מדגם ומספר סידורי, עם מקור ברור וקישור לתיק השירות."
              : "Review model and serial extraction with clear provenance and a direct path to the service case."}
          </p>
        </div>
      </header>

      <FieldServiceNavigation active="ocr" />

      <section
        aria-label={he ? "סקירת תור OCR" : "OCR queue overview"}
        className="field-service-metrics"
      >
        {[
          {
            icon: ScanText,
            label: he ? "תוצאות אחרונות" : "Latest results",
            value: counts.all,
          },
          {
            icon: AlertTriangle,
            label: he ? "דורש טיפול" : "Needs attention",
            value: counts.attention,
          },
          {
            icon: Clock3,
            label: he ? "ממתין או בעיבוד" : "Queued or processing",
            value: counts.inFlight,
          },
          {
            icon: CircleCheckBig,
            label: he ? "הושלם ואושר" : "Completed & confirmed",
            value: counts.completed,
          },
        ].map(({ icon: Icon, label, value }) => (
          <Surface as="article" key={label} level="raised">
            <span className="field-service-metric__icon">
              <Icon aria-hidden="true" size={19} />
            </span>
            <span>
              <small>{label}</small>
              <strong>
                <AnimatedNumber animateOnMount locale={locale} value={value} />
              </strong>
            </span>
          </Surface>
        ))}
      </section>

      {!feature.ocrEnabled ? (
        <InlineFeedback
          description={
            he
              ? "עיבוד OCR חדש כבוי בהגדרות סביבת העבודה. תוצאות קיימות נשמרות וזמינות לבדיקה."
              : "New OCR processing is disabled in workspace settings. Existing results remain available for review."
          }
          title={he ? "OCR אופציונלי כבוי" : "Optional OCR is off"}
          tone="warning"
        />
      ) : null}

      <div className="field-service-toolbar field-service-ocr-toolbar">
        <div
          aria-label={he ? "סינון תוצאות OCR" : "Filter OCR results"}
          className="field-service-tabs field-service-ocr-tabs"
          role="group"
        >
          {tabs.map((tab) => (
            <button
              aria-pressed={view === tab.id}
              key={tab.id}
              onClick={() => void load({ append: false, query, view: tab.id })}
              type="button"
            >
              <span>{tab.label}</span>
              <small>{tab.count}</small>
            </button>
          ))}
        </div>
        <form className="field-service-search" onSubmit={submit} role="search">
          <Search aria-hidden="true" size={15} />
          <label className="or-visually-hidden" htmlFor="ocr-queue-search">
            {he ? "חיפוש בתור OCR" : "Search OCR queue"}
          </label>
          <input
            id="ocr-queue-search"
            maxLength={500}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              he
                ? "חיפוש לפי תיק, לקוח, דגם או מספר סידורי…"
                : "Search case, customer, model, or serial…"
            }
            type="search"
            value={query}
          />
          <button
            className="or-button or-button--quiet or-button--small"
            disabled={pending}
            type="submit"
          >
            {he ? "חיפוש" : "Search"}
          </button>
        </form>
      </div>

      {error === undefined ? null : (
        <InlineFeedback description={error} tone="critical" />
      )}

      {items.length === 0 ? (
        <EmptyState
          action={
            <span aria-hidden="true" className="field-service-ocr-empty-icon">
              <ScanSearch size={24} />
            </span>
          }
          description={
            appliedQuery
              ? he
                ? "לא נמצאו תוצאות שתואמות לחיפוש ולמסנן הנוכחי."
                : "No results match the current search and filter."
              : view === "attention"
                ? he
                  ? "כל התוצאות האחרונות טופלו או עדיין בתהליך."
                  : "Every latest result is handled or still processing."
                : he
                  ? "תוצאות יופיעו כאן לאחר שליחת תמונת תווית מוצר לעיבוד."
                  : "Results will appear after a product-label image is submitted for processing."
          }
          title={
            view === "attention"
              ? he
                ? "אין פריטים שממתינים לבדיקה"
                : "Nothing needs review"
              : he
                ? "אין תוצאות בתצוגה הזו"
                : "No results in this view"
          }
        />
      ) : (
        <section
          aria-label={he ? "תוצאות OCR" : "OCR results"}
          className="field-service-ocr-grid"
        >
          {items.map((item) => {
            const values = {
              ...item.proposedFields,
              ...item.confirmedFields,
            };
            const evidenceAvailable =
              item.evidenceStatus === "available" &&
              item.attachmentProcessingStatus === "available";
            return (
              <Surface
                as="article"
                className="field-service-ocr-card"
                data-status={item.status}
                key={item.id}
                level="raised"
              >
                <header>
                  <div>
                    <Badge
                      label={
                        item.status === "confirmed"
                          ? he
                            ? "הושלם ואושר"
                            : "Completed & confirmed"
                          : ocrStatusLabel(item.status, he)
                      }
                      tone={statusTone(item.status)}
                    />
                    <small>
                      {he
                        ? `ניסיון ${String(item.attempt)}`
                        : `Attempt ${String(item.attempt)}`}
                    </small>
                  </div>
                  <time dateTime={item.completedAt ?? item.createdAt}>
                    {dateTime.format(
                      new Date(item.completedAt ?? item.createdAt),
                    )}
                  </time>
                </header>

                <div className="field-service-ocr-card__case">
                  <span className="field-service-metric__icon">
                    <FileImage aria-hidden="true" size={18} />
                  </span>
                  <div>
                    <Link href={`/field-service/cases/${item.caseId}`}>
                      <strong dir="ltr">{item.caseReference}</strong>
                    </Link>
                    <p dir="auto">{item.customerName}</p>
                    <small dir="auto">
                      {item.caseTitle}
                      {item.serviceLocationName ? (
                        <>
                          {" "}
                          · <MapPin aria-hidden="true" size={12} />{" "}
                          {item.serviceLocationName}
                        </>
                      ) : null}
                    </small>
                  </div>
                </div>

                {item.errorSafe ? (
                  <InlineFeedback
                    description={item.errorSafe}
                    tone="critical"
                  />
                ) : null}

                <dl className="field-service-ocr-fields">
                  {Object.entries(values).length === 0 ? (
                    <div className="field-service-ocr-fields__empty">
                      <dt>{he ? "שדות שחולצו" : "Extracted fields"}</dt>
                      <dd>
                        {item.status === "pending" ||
                        item.status === "processing"
                          ? he
                            ? "החילוץ עדיין בתהליך."
                            : "Extraction is still in progress."
                          : he
                            ? "לא הוחזרו שדות. יש לבדוק את הראיה המקורית."
                            : "No fields were returned. Review the source evidence."}
                      </dd>
                    </div>
                  ) : (
                    Object.entries(values).map(([field, value]) => (
                      <div key={field}>
                        <dt>{fieldLabel(field, he)}</dt>
                        <dd dir="auto">{value}</dd>
                      </div>
                    ))
                  )}
                </dl>

                <div className="field-service-ocr-provenance">
                  <span>
                    {he ? "מקור" : "Source"}: {sourceLabel(item.source, he)}
                  </span>
                  <span>
                    {he ? "סוג ראיה" : "Evidence"}:{" "}
                    {evidenceCategoryLabel(item.category, he)}
                  </span>
                  <span dir="auto">
                    {he ? "ספק" : "Provider"}: {item.provider ?? "—"}
                    {item.model ? ` · ${item.model}` : ""}
                  </span>
                  <span>
                    {he ? "ביטחון" : "Confidence"}:{" "}
                    {item.confidence === null
                      ? he
                        ? "לא זמין"
                        : "Unavailable"
                      : `${String(Math.round(item.confidence * 100))}%`}
                  </span>
                  {item.manuallyConfirmedFields.length > 0 ? (
                    <span>
                      {he ? "אימות ידני" : "Manually confirmed"}:{" "}
                      {item.manuallyConfirmedFields
                        .map((field) => fieldLabel(field, he))
                        .join(", ")}
                    </span>
                  ) : null}
                </div>

                <footer>
                  <span>
                    {he ? "קובץ" : "File"}:{" "}
                    {processingStatusLabel(item.evidenceStatus, he)} ·{" "}
                    {he ? "קליטה" : "Ingestion"}:{" "}
                    {processingStatusLabel(item.attachmentProcessingStatus, he)}{" "}
                    · <bdi>{item.contentType}</bdi>
                  </span>
                  <div>
                    {evidenceAvailable ? (
                      <a
                        className="or-button or-button--quiet or-button--small"
                        href={`/api/field-service/attachments/${item.objectId}`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <ExternalLink aria-hidden="true" size={14} />
                        {he ? "הצגת הראיה" : "View evidence"}
                      </a>
                    ) : (
                      <span className="field-service-ocr-card__unavailable">
                        {he ? "הראיה אינה זמינה" : "Evidence unavailable"}
                      </span>
                    )}
                    <Link
                      className="or-button or-button--secondary or-button--small"
                      href={`/field-service/cases/${item.caseId}`}
                    >
                      {canOperate &&
                      (item.status === "review_required" ||
                        item.status === "failed")
                        ? he
                          ? "בדיקה בתיק"
                          : "Review in case"
                        : he
                          ? "פתיחת התיק"
                          : "Open case"}
                    </Link>
                  </div>
                </footer>
              </Surface>
            );
          })}
        </section>
      )}
      <div className="field-service-ocr-pagination">
        <span aria-live="polite" role="status">
          {he
            ? `מוצגים ${String(items.length)} מתוך ${String(selectedTotal)}`
            : `Showing ${String(items.length)} of ${String(selectedTotal)}`}
        </span>
        {nextCursor === null ? null : (
          <button
            className="or-button or-button--secondary or-button--small"
            disabled={pending}
            onClick={() => void load({ append: true })}
            type="button"
          >
            {pending
              ? he
                ? "טוען…"
                : "Loading…"
              : he
                ? "טעינת תוצאות נוספות"
                : "Load more results"}
          </button>
        )}
      </div>
    </div>
  );
}
