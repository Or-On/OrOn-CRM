"use client";

import type {
  InquiryDetail,
  ServiceAttachmentSummary,
  ServiceInquiry,
  ServiceInquiryPage,
  ServiceInquiryStatus,
  ServiceManagerMetrics,
  ServiceOverviewPeriod,
  TicketSummary,
} from "@or-on/crm";
import {
  Badge,
  Button,
  DataTable,
  Input,
  PageHeader,
  Select,
  Surface,
  Textarea,
} from "@or-on/ui";
import { useLocale } from "next-intl";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { tenantDateFormatter } from "../../i18n/tenant-date-time";
import { csrfToken } from "../crm";
import { InquiryPanel } from "../tickets";
import styles from "./service-manager.module.css";

const statuses: Record<ServiceInquiryStatus, readonly [string, string]> = {
  open: ["Open", "פתוח"],
  scheduled: ["Technician scheduled", "תואם טכנאי"],
  telephone: ["Resolved by telephone", "טופל טלפוני"],
  technician: ["Resolved by technician", "טופל ע״י טכנאי"],
  closed: ["Closed · handling method not recorded", "סגור · סוג טיפול לא תועד"],
};
function Status({
  value,
  he,
}: {
  readonly value: ServiceInquiryStatus;
  readonly he: boolean;
}) {
  return (
    <Badge
      label={statuses[value][he ? 1 : 0]}
      tone={
        value === "open"
          ? "neutral"
          : value === "scheduled"
            ? "info"
            : "positive"
      }
    />
  );
}

export function ServiceManagerOverview({
  tenantName,
  metrics,
  period,
}: {
  readonly tenantName: string;
  readonly metrics: ServiceManagerMetrics;
  readonly period: ServiceOverviewPeriod;
}) {
  const locale = useLocale();
  const he = locale.startsWith("he");
  return (
    <main className="page">
      <PageHeader
        title={tenantName}
        eyebrow={he ? "סקירה" : "Overview"}
        description={he ? "פעילות השירות של העסק" : "Your service activity"}
      />
      <nav
        className={styles.periods}
        aria-label={he ? "טווח תאריכים" : "Date range"}
      >
        {(
          [
            ["today", "Today", "היום"],
            ["week", "Last 7 days", "7 ימים אחרונים"],
            ["month", "This month", "החודש"],
          ] as const
        ).map(([key, en, heb]) => (
          <Link
            key={key}
            aria-current={period === key ? "page" : undefined}
            href={`/?period=${key}`}
          >
            {he ? heb : en}
          </Link>
        ))}
      </nav>
      <p>
        {metrics.since} — {metrics.until}
      </p>
      <div className={styles.metrics}>
        {(
          [
            [metrics.incomingCalls, "Incoming calls", "שיחות שהתקבלו"],
            [metrics.incomingMessages, "Incoming messages", "הודעות שהתקבלו"],
            [metrics.opened, "Requests opened", "קריאות שירות שנפתחו"],
            [metrics.closed, "Requests closed", "קריאות שירות שנסגרו"],
          ] as const
        ).map(([value, en, heb]) => (
          <Surface as="article" level="raised" key={en}>
            <span>{he ? heb : en}</span>
            <strong>{value.toLocaleString(locale)}</strong>
          </Surface>
        ))}
      </div>
      <div className={styles.links}>
        <Link
          className="or-button or-button--primary or-button--medium"
          href="/tickets"
        >
          {he ? "כל הפניות" : "All inquiries"}
        </Link>
        <Link
          className="or-button or-button--secondary or-button--medium"
          href="/field-service"
        >
          {he ? "שירות שטח" : "Field service"}
        </Link>
      </div>
    </main>
  );
}

export function ServiceInquiryRegister({
  initialPage,
  timezone,
  emergencyLabel,
}: {
  readonly initialPage: ServiceInquiryPage;
  readonly timezone: string;
  readonly emergencyLabel?: string | null;
}) {
  const locale = useLocale();
  const he = locale.startsWith("he");
  const formatter = tenantDateFormatter(locale, timezone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const [page, setPage] = useState(initialPage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [filters, setFilters] = useState({
    status: "all",
    q: "",
    since: "",
    until: "",
  });
  const [applied, setApplied] = useState(filters);
  async function load(append: boolean, nextFilters = applied) {
    setBusy(true);
    setError(false);
    try {
      const parameters = new URLSearchParams(
        Object.entries(nextFilters).filter(([, value]) => value !== ""),
      );
      if (append && page.nextCursor !== null) {
        parameters.set("beforeOpenedAt", page.nextCursor.openedAt);
        parameters.set("beforeId", page.nextCursor.id);
      }
      const response = await fetch(`/api/service-inquiries?${parameters}`);
      if (!response.ok) throw new Error("load");
      const result = (await response.json()) as ServiceInquiryPage;
      setPage((current) => ({
        ...result,
        inquiries: append
          ? [...current.inquiries, ...result.inquiries]
          : result.inquiries,
      }));
      setApplied(nextFilters);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.workspace}>
      <PageHeader
        title={he ? "פניות" : "Inquiries"}
        description={
          he
            ? "כל הפניות לפי תאריך פתיחה, מהחדשה לישנה"
            : "All inquiries, newest opening date first"
        }
      />
      <form
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
          void load(false, filters);
        }}
      >
        <Input
          id="service-query"
          label={he ? "חיפוש" : "Search"}
          value={filters.q}
          onChange={(event) =>
            setFilters({ ...filters, q: event.target.value })
          }
        />
        <Select
          id="service-status"
          label={he ? "סטטוס" : "Status"}
          value={filters.status}
          onChange={(event) =>
            setFilters({ ...filters, status: event.target.value })
          }
        >
          <option value="all">{he ? "הכול" : "All"}</option>
          {Object.entries(statuses).map(([key, labels]) => (
            <option key={key} value={key}>
              {labels[he ? 1 : 0]}
            </option>
          ))}
        </Select>
        <Input
          id="service-since"
          label={he ? "מתאריך" : "From"}
          type="date"
          value={filters.since}
          onChange={(event) =>
            setFilters({ ...filters, since: event.target.value })
          }
        />
        <Input
          id="service-until"
          label={he ? "עד תאריך" : "To"}
          type="date"
          value={filters.until}
          onChange={(event) =>
            setFilters({ ...filters, until: event.target.value })
          }
        />
        <Button type="submit" disabled={busy}>
          {he ? "הצגה" : "Show"}
        </Button>
      </form>
      {error ? (
        <p role="alert">
          {he
            ? "לא ניתן לטעון פניות. נסו שוב."
            : "Could not load inquiries. Try again."}
        </p>
      ) : null}
      <Surface level="raised">
        <DataTable label={he ? "כל הפניות" : "All inquiries"} minWidth="46rem">
          <thead>
            <tr>
              {[
                he ? "פנייה" : "Inquiry",
                he ? "תאריך פתיחה" : "Opened",
                he ? "לקוח / אתר" : "Customer / site",
                he ? "סטטוס" : "Status",
                he ? "מועד טכנאי" : "Technician appointment",
              ].map((label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.inquiries.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link href={`/tickets/${item.id}`}>
                    <bdi>{item.reference}</bdi>
                    <br />
                    {item.subject}
                  </Link>
                  {item.emergency ? (
                    <Badge
                      tone="critical"
                      label={emergencyLabel ?? (he ? "דחוף" : "Emergency")}
                    />
                  ) : null}
                </td>
                <td>{formatter.format(new Date(item.openedAt))}</td>
                <td>
                  {item.customer}
                  {item.location ? (
                    <>
                      <br />
                      {item.location}
                    </>
                  ) : null}
                </td>
                <td>
                  <Status value={item.status} he={he} />
                </td>
                <td>
                  {item.appointmentAt
                    ? formatter.format(new Date(item.appointmentAt))
                    : "—"}
                  {item.technician ? (
                    <>
                      <br />
                      {item.technician}
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
            {page.inquiries.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  {he ? "אין פניות בתצוגה זו" : "No inquiries in this view"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </DataTable>
      </Surface>
      {page.nextCursor ? (
        <Button disabled={busy} onClick={() => void load(true)}>
          {he ? "הצגת עוד" : "Load more"}
        </Button>
      ) : null}
    </section>
  );
}

function Photo({
  url,
  label,
  image = true,
}: {
  readonly url: string;
  readonly label: string;
  readonly image?: boolean;
}) {
  const he = useLocale().startsWith("he");
  const [failed, setFailed] = useState(false);
  return (
    <a href={url} target="_blank" rel="noreferrer" className={styles.photo}>
      {/* Authenticated, private media must bypass the public image optimizer. */}
      {image && !failed ? (
        <Image
          unoptimized
          width={320}
          height={160}
          src={url}
          alt={label}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : null}
      <span>{label}</span>
      {failed ? (
        <small>
          {he
            ? "התמונה אינה זמינה — פתיחת הקובץ"
            : "Image unavailable — open file"}
        </small>
      ) : null}
    </a>
  );
}

export function ServiceInquiryDetail({
  item,
  inquiry,
  attachments,
  timezone,
  canResolve,
  ticket,
  emergencyLabel,
  canMarkEmergency,
}: {
  readonly item: ServiceInquiry;
  readonly inquiry: InquiryDetail | null;
  readonly attachments: readonly ServiceAttachmentSummary[];
  readonly timezone: string;
  readonly canResolve: boolean;
  readonly ticket: TicketSummary;
  readonly emergencyLabel: string | null;
  readonly canMarkEmergency: boolean;
}) {
  const locale = useLocale();
  const he = locale.startsWith("he");
  const router = useRouter();
  const formatter = tenantDateFormatter(locale, timezone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const [method, setMethod] = useState("telephone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function resolve(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(
        `/api/service-inquiries/${item.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfToken(),
          },
          body: JSON.stringify({
            method,
            confirmation: form.get("confirmation"),
            summary: form.get("summary"),
          }),
        },
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(body.error ?? "Could not close inquiry");
      router.refresh();
    } catch (failure) {
      const message =
        failure instanceof Error ? failure.message : "Could not close inquiry";
      const translations: Record<string, string> = {
        "Select a resolution method and confirmation":
          "יש לבחור סוג טיפול ואישור לסגירת הפניה",
        "Enter a resolution summary": "יש להזין סיכום טיפול",
        "Inquiry is unavailable or already closed":
          "הפניה אינה זמינה או שכבר נסגרה",
        "A completed technician service case is required":
          "נדרש תיק שירות שהטכנאי סיים לטפל בו",
        "Service case is unavailable": "תיק השירות אינו זמין",
        "Complete the technician work before closing the inquiry":
          "יש לסיים את עבודת הטכנאי לפני סגירת הפניה",
        "Cancel pending field work before recording telephone resolution":
          "יש לבטל את הביקורים שטרם הושלמו לפני סגירת הפניה כטיפול טלפוני",
      };
      setError(
        he
          ? (translations[message] ??
              "לא ניתן לסגור את הפניה. יש לבדוק את פרטי הטיפול ולנסות שוב.")
          : message,
      );
    } finally {
      setBusy(false);
    }
  }
  const customerAttachments = attachments.filter(
    (attachment) => attachment.source === "customer",
  );
  const technicianAttachments = attachments.filter(
    (attachment) =>
      attachment.source === "technician" &&
      !attachment.category.endsWith("_signature"),
  );
  const otherAttachments = attachments.filter(
    (attachment) => !["customer", "technician"].includes(attachment.source),
  );
  const customerMessages =
    inquiry?.messages.filter((message) => message.direction === "inbound") ??
    [];
  return (
    <section className={styles.workspace}>
      <PageHeader
        title={item.subject}
        eyebrow={item.reference}
        meta={<Status value={item.status} he={he} />}
        actions={
          <Link href="/tickets">
            {he ? "חזרה לפניות" : "Back to inquiries"}
          </Link>
        }
      />
      <InquiryPanel
        ticket={ticket}
        inquiry={null}
        emergencyLabel={emergencyLabel}
        canMarkEmergency={canMarkEmergency}
        tenantTimeZone={timezone}
      />
      <Surface level="raised">
        <h2>{he ? "פרטי הפנייה" : "Inquiry details"}</h2>
        <dl className={styles.facts}>
          <div>
            <dt>{he ? "לקוח" : "Customer"}</dt>
            <dd>{item.customer}</dd>
          </div>
          <div>
            <dt>{he ? "אתר" : "Site"}</dt>
            <dd>{item.location ?? inquiry?.fields.serviceAddress ?? "—"}</dd>
          </div>
          <div>
            <dt>{he ? "תאריך פתיחה" : "Opened"}</dt>
            <dd>{formatter.format(new Date(item.openedAt))}</dd>
          </div>
          <div>
            <dt>{he ? "תואם טכנאי ליום" : "Technician appointment"}</dt>
            <dd>
              {item.appointmentAt
                ? `${formatter.format(new Date(item.appointmentAt))}${item.appointmentEnd ? ` — ${formatter.format(new Date(item.appointmentEnd))}` : ""}`
                : he
                  ? "טרם תואם"
                  : "Not scheduled"}
              {item.technician ? (
                <>
                  <br />
                  {item.technician}
                </>
              ) : null}
            </dd>
          </div>
          {inquiry?.fields.customerPhone ? (
            <div>
              <dt>{he ? "טלפון" : "Phone"}</dt>
              <dd>
                <a href={`tel:${inquiry.fields.customerPhone}`}>
                  <bdi dir="ltr">{inquiry.fields.customerPhone}</bdi>
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
        <h3>{he ? "תיאור הבעיה" : "Problem description"}</h3>
        <p className={styles.problem} dir="auto">
          {item.faultDescription ??
            (he
              ? "טרם התקבל תיאור הבעיה"
              : "Problem description not received yet")}
        </p>
        {inquiry?.fields.exactFailure &&
        inquiry.fields.exactFailure !== item.faultDescription ? (
          <p className={styles.problem} dir="auto">
            {inquiry.fields.exactFailure}
          </p>
        ) : null}
        {item.caseId ? (
          <Link href={`/field-service/cases/${item.caseId}`}>
            {he
              ? "תיאום טכנאי ופרטי עבודת השירות"
              : "Scheduling and field work"}
          </Link>
        ) : null}
      </Surface>
      <Surface level="raised">
        <h2>{he ? "תמונות והודעות הלקוח" : "Customer photos and messages"}</h2>
        <div className={styles.photos}>
          {customerAttachments.map((attachment) => (
            <Photo
              key={attachment.id}
              url={`/api/field-service/attachments/${attachment.objectId}`}
              image={attachment.contentType.startsWith("image/")}
              label={
                attachment.caption ??
                (he ? "תמונת לקוח" : "Customer attachment")
              }
            />
          ))}
          {customerMessages
            .filter(
              (message) =>
                message.hasMedia &&
                !customerAttachments.some(
                  (attachment) => attachment.objectId === message.objectId,
                ),
            )
            .map((message) => (
              <Photo
                key={message.messageId}
                url={`/api/messaging/messages/${message.messageId}/media`}
                image={message.contentType === "image"}
                label={he ? "קובץ מהלקוח" : "Customer attachment"}
              />
            ))}
        </div>
        {customerMessages
          .filter((message) => message.text)
          .map((message) => (
            <p key={message.messageId} className={styles.problem} dir="auto">
              {message.text}
            </p>
          ))}
        {customerAttachments.length === 0 && customerMessages.length === 0 ? (
          <p>
            {he
              ? "טרם התקבלו הודעות או תמונות"
              : "No messages or photos received yet"}
          </p>
        ) : null}
        {inquiry?.repliesToLink.length ? (
          <details>
            <summary>
              {he ? "הודעות שצריך לשייך לפנייה" : "Replies needing assignment"}
            </summary>
            <InquiryPanel
              ticket={ticket}
              inquiry={inquiry}
              emergencyLabel={null}
              canMarkEmergency={false}
              tenantTimeZone={timezone}
            />
          </details>
        ) : null}
      </Surface>
      <Surface level="raised">
        <h2>{he ? "תמונות הטכנאי" : "Technician photos"}</h2>
        <div className={styles.photos}>
          {technicianAttachments.map((attachment) => (
            <Photo
              key={attachment.id}
              url={`/api/field-service/attachments/${attachment.objectId}`}
              image={attachment.contentType.startsWith("image/")}
              label={`${attachment.caption ?? (attachment.category === "before_photo" ? (he ? "לפני טיפול" : "Before work") : attachment.category === "after_photo" ? (he ? "אחרי טיפול" : "After work") : he ? "צילום טכנאי" : "Technician attachment")} · ${formatter.format(new Date(attachment.createdAt))}`}
            />
          ))}
        </div>
        {technicianAttachments.length === 0 ? (
          <p>
            {he
              ? "טרם הועלו תמונות טכנאי"
              : "No technician photos uploaded yet"}
          </p>
        ) : null}
      </Surface>
      {otherAttachments.length ? (
        <Surface level="raised">
          <h2>{he ? "מסמכים נוספים" : "Other documents"}</h2>
          <div className={styles.photos}>
            {otherAttachments.map((attachment) => (
              <Photo
                key={attachment.id}
                url={`/api/field-service/attachments/${attachment.objectId}`}
                image={attachment.contentType.startsWith("image/")}
                label={attachment.caption ?? (he ? "קובץ מצורף" : "Attachment")}
              />
            ))}
          </div>
        </Surface>
      ) : null}
      {canResolve && (item.status === "open" || item.status === "scheduled") ? (
        <Surface level="raised">
          <h2>{he ? "סיום טיפול" : "Complete inquiry"}</h2>
          <form
            onSubmit={(event) => void resolve(event)}
            className={styles.resolution}
          >
            <Select
              id="resolution-method"
              label={he ? "אופן הטיפול" : "Resolution method"}
              value={method}
              onChange={(event) => setMethod(event.target.value)}
            >
              <option value="telephone">
                {statuses.telephone[he ? 1 : 0]}
              </option>
              <option
                value="technician"
                disabled={
                  !["completed", "closed"].includes(item.caseStatus ?? "")
                }
              >
                {statuses.technician[he ? 1 : 0]}
              </option>
            </Select>
            <Select
              id="resolution-confirmation"
              name="confirmation"
              label={he ? "אימות הפתרון" : "Resolution confirmation"}
            >
              <option value="customer">
                {he
                  ? "הלקוח אישר שהבעיה נפתרה"
                  : "Customer confirmed resolution"}
              </option>
              <option value="authoritative_evidence">
                {he
                  ? "דוח או תיעוד מאמתים את הפתרון"
                  : "Verified by report or evidence"}
              </option>
            </Select>
            <Textarea
              id="resolution-summary"
              name="summary"
              label={he ? "סיכום הטיפול" : "Resolution summary"}
              required
              maxLength={1000}
            />
            <Button type="submit" disabled={busy}>
              {he ? "סגירת הפנייה" : "Close inquiry"}
            </Button>
            {error ? <p role="alert">{error}</p> : null}
          </form>
        </Surface>
      ) : null}
      <details>
        <summary>
          {he ? "תקשורת ופרטים מתקדמים" : "Communication and advanced details"}
        </summary>
        <div className={styles.links}>
          {ticket.sourceConversationId ? (
            <Link href={`/inbox?conversation=${ticket.sourceConversationId}`}>
              {he ? "פתיחת שיחת הלקוח" : "Open customer conversation"}
            </Link>
          ) : null}
          <Link href="/settings">{he ? "הגדרות" : "Settings"}</Link>
        </div>
      </details>
    </section>
  );
}

export function AdvancedServiceTools({
  enabled,
}: {
  readonly enabled: readonly string[];
}) {
  const he = useLocale().startsWith("he");
  const links = [
    {
      feature: "whatsapp",
      href: "/inbox",
      en: "Customer conversations",
      he: "שיחות לקוח",
    },
    {
      feature: "whatsapp",
      href: "/operations",
      en: "Messaging operations",
      he: "ניהול שליחת הודעות",
    },
    {
      feature: "voice",
      href: "/voice",
      en: "Telephone operations",
      he: "ניהול שיחות טלפון",
    },
    {
      feature: "agents",
      href: "/orchestration",
      en: "Automation settings",
      he: "הגדרות אוטומציה",
    },
    {
      feature: "ocr",
      href: "/field-service/ocr",
      en: "Document extraction",
      he: "חילוץ מידע ממסמכים",
    },
  ].filter((item) => enabled.includes(item.feature));
  return (
    <details className={styles.workspace}>
      <summary>{he ? "כלים מתקדמים" : "Advanced tools"}</summary>
      <p>
        {he
          ? "כלים לניהול ערוצי התקשורת והאוטומציה של העסק."
          : "Manage the business communication channels and automation."}
      </p>
      <nav
        className={styles.links}
        aria-label={he ? "כלים מתקדמים" : "Advanced tools"}
      >
        {links.map((item) => (
          <Link key={item.href} href={item.href}>
            {he ? item.he : item.en}
          </Link>
        ))}
      </nav>
    </details>
  );
}
