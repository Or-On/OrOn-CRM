"use client";

import type { ServiceCaseSummary } from "@or-on/crm";
import { Badge, Button, EmptyState, InlineFeedback, Surface } from "@or-on/ui";
import { MapPin, RefreshCw, Wrench } from "lucide-react";
import { useLocale } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { crmMutation, crmRead } from "../crm";
import { casePriorityLabel, caseStatusLabel } from "./field-service-labels";

interface QueueItem {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly faultDescription: string | null;
  readonly status: ServiceCaseSummary["status"];
  readonly priority: ServiceCaseSummary["priority"];
  readonly customerName: string;
  readonly storeName: string | null;
  readonly chainName: string | null;
  readonly assignedTechnicianId: string | null;
  readonly assignedTechnicianName: string | null;
  readonly updatedAt: string;
}

interface QueuePage {
  readonly items: readonly QueueItem[];
  readonly policy: { readonly selfAssignmentEnabled: boolean };
}

export function TechnicianQueue({ canClaim }: { readonly canClaim: boolean }) {
  const he = useLocale().startsWith("he");
  const router = useRouter();
  const [view, setView] = useState<"available" | "mine">("mine");
  const [page, setPage] = useState<QueuePage>();
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [claiming, setClaiming] = useState<string>();
  const [feedback, setFeedback] = useState<{
    message: string;
    critical: boolean;
    identify?: boolean;
  }>();
  const requestNumber = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const request = ++requestNumber.current;
    setLoading(true);
    setPage(undefined);
    void crmRead<QueuePage>(`/api/field-service/queue?view=${view}`)
      .then((result) => {
        if (!cancelled && request === requestNumber.current) setPage(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // This device's technician was released elsewhere in the session;
        // reloading shows the identification step again.
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "TECHNICIAN_IDENTIFICATION_REQUIRED"
        ) {
          setFeedback({
            critical: true,
            identify: true,
            message: he
              ? "יש לבחור מי הטכנאי שעובד במכשיר הזה."
              : "Choose which technician is working on this device.",
          });
          return;
        }
        setFeedback({
          critical: true,
          message:
            error instanceof Error
              ? error.message
              : he
                ? "לא ניתן לטעון את האירועים."
                : "Could not load incidents.",
        });
      })
      .finally(() => {
        if (!cancelled && request === requestNumber.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [he, refresh, view]);

  async function claim(item: QueueItem) {
    if (claiming !== undefined) return;
    setClaiming(item.id);
    setFeedback(undefined);
    try {
      await crmMutation(
        `/api/field-service/cases/${item.id}/claim`,
        {},
        { method: "POST" },
      );
      setFeedback({
        critical: false,
        message: he
          ? `האירוע ${item.reference} שויך אליך.`
          : `${item.reference} is now assigned to you.`,
      });
      router.push(`/field-service/cases/${item.id}`);
      router.refresh();
      setRefresh((value) => value + 1);
    } catch (error) {
      setFeedback({
        critical: true,
        message:
          error instanceof Error
            ? error.message
            : he
              ? "השיוך נכשל. יש לרענן ולנסות שוב."
              : "The incident could not be assigned. Refresh and try again.",
      });
      setRefresh((value) => value + 1);
    } finally {
      setClaiming(undefined);
    }
  }

  return (
    <section
      className="technician-queue"
      aria-labelledby="technician-queue-heading"
      dir={he ? "rtl" : "ltr"}
    >
      <div className="field-service-toolbar">
        <div>
          <h2 id="technician-queue-heading">
            {he ? "העבודה שלי בשטח" : "My field work"}
          </h2>
          <p>
            {he
              ? "בחירת אירוע, תיעוד העבודה והשלמת דוח — במקום אחד."
              : "Take an incident, record the work, and complete the report."}
          </p>
        </div>
        <Button
          variant="quiet"
          disabled={loading || claiming !== undefined}
          onClick={() => {
            setFeedback(undefined);
            setRefresh((value) => value + 1);
          }}
        >
          <RefreshCw aria-hidden="true" size={16} />
          {he ? "רענון" : "Refresh"}
        </Button>
      </div>
      <div
        className="field-service-tabs"
        role="group"
        aria-label={he ? "סינון אירועים" : "Incident queue"}
      >
        <button
          type="button"
          aria-pressed={view === "mine"}
          onClick={() => {
            setFeedback(undefined);
            setView("mine");
          }}
        >
          {he ? "האירועים שלי" : "My incidents"}
        </button>
        <button
          type="button"
          aria-pressed={view === "available"}
          onClick={() => {
            setFeedback(undefined);
            setView("available");
          }}
        >
          {he ? "זמינים לטיפול" : "Available incidents"}
        </button>
      </div>
      {feedback ? (
        <InlineFeedback
          {...(feedback.identify === true
            ? {
                action: (
                  <Button
                    onClick={() => router.refresh()}
                    size="small"
                    variant="secondary"
                  >
                    {he ? "בחירת טכנאי" : "Choose technician"}
                  </Button>
                ),
              }
            : {})}
          description={feedback.message}
          tone={feedback.critical ? "critical" : "positive"}
        />
      ) : null}
      <div aria-busy={loading} aria-live="polite">
        {loading ? (
          <p className="technician-queue__notice" role="status">
            {he ? "טוען אירועים…" : "Loading incidents…"}
          </p>
        ) : page?.items.length === 0 ? (
          <Surface level="raised">
            <EmptyState
              title={
                view === "mine"
                  ? he
                    ? "אין אירועים משויכים"
                    : "No assigned incidents"
                  : he
                    ? "אין אירועים זמינים"
                    : "No available incidents"
              }
              description={
                view === "mine"
                  ? he
                    ? "ניתן לבחור אירוע זמין לטיפול או להמתין לשיוך מהמנהל."
                    : "Choose an available incident or wait for your manager to assign work."
                  : he
                    ? "אירועים חדשים שעברו קליטה יופיעו כאן."
                    : "New incidents will appear here once customer intake is complete."
              }
            />
          </Surface>
        ) : (
          <div className="technician-queue__grid">
            {page?.items.map((item) => (
              <Surface
                as="article"
                key={item.id}
                className="technician-queue__card"
                level="raised"
              >
                <header>
                  <bdi dir="ltr">{item.reference}</bdi>
                  <Badge
                    label={casePriorityLabel(item.priority, he)}
                    tone={item.priority === "urgent" ? "warning" : "neutral"}
                  />
                </header>
                <h3 dir="auto">{item.title}</h3>
                <p dir="auto">{item.faultDescription}</p>
                <dl>
                  <div>
                    <dt>{he ? "לקוח" : "Customer"}</dt>
                    <dd dir="auto">{item.customerName}</dd>
                  </div>
                  <div>
                    <dt>
                      <MapPin size={14} aria-hidden="true" />
                      {he ? "רשת וסניף" : "Chain & store"}
                    </dt>
                    <dd dir="auto">
                      {[item.chainName, item.storeName]
                        .filter(Boolean)
                        .join(" · ") || (he ? "לא צוין" : "Not supplied")}
                    </dd>
                  </div>
                </dl>
                <footer>
                  <Badge
                    label={caseStatusLabel(item.status, he)}
                    tone="neutral"
                  />
                  {view === "available" ? (
                    canClaim && page.policy.selfAssignmentEnabled ? (
                      <Button
                        busy={claiming === item.id}
                        disabled={claiming !== undefined}
                        onClick={() => void claim(item)}
                      >
                        <Wrench aria-hidden="true" size={16} />
                        {he ? "לקחת לטיפולי" : "Take this incident"}
                      </Button>
                    ) : (
                      <span>
                        {he
                          ? "ממתין לשיוך מנהל"
                          : "Awaiting manager assignment"}
                      </span>
                    )
                  ) : (
                    <Link
                      className="or-button or-button--secondary"
                      href={`/field-service/cases/${item.id}`}
                    >
                      {he ? "פתיחת האירוע" : "Open incident"}
                    </Link>
                  )}
                </footer>
              </Surface>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
