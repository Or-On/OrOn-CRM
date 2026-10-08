"use client";

import type { IncompleteServiceRequest } from "@or-on/crm";
import { Badge, Button, ConfirmDialog, Surface } from "@or-on/ui";
import { useCallback, useEffect, useState } from "react";
import { crmMutation, crmRead } from "../crm";

const labels = {
  retry: "ניסיון שליחה נוסף",
  new_request: "יצירת קישור חדש",
  close: "סגירת בקשה",
} as const;

export function IncompleteRequests({
  canManage,
}: {
  readonly canManage: boolean;
}) {
  const [requests, setRequests] = useState<readonly IncompleteServiceRequest[]>(
    [],
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [action, setAction] = useState<{
    intakeId: string;
    action: keyof typeof labels;
    operationId: string;
  }>();
  const refresh = useCallback(async () => {
    try {
      const result = await crmRead<{
        requests: readonly IncompleteServiceRequest[];
      }>("/api/field-service/incomplete");
      if (!Array.isArray(result.requests))
        throw new TypeError("Invalid incomplete request response");
      setRequests(result.requests);
      setLoaded(true);
      setError("");
    } catch {
      setError("לא ניתן לטעון כרגע את הבקשות שלא הושלמו.");
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function confirm() {
    if (!action || pending) return;
    setPending(true);
    try {
      const result = await crmMutation<{ message: string }>(
        "/api/field-service/incomplete",
        action,
      );
      setNotice(result.message);
      setAction(undefined);
      await refresh();
    } catch {
      setError(
        "לא ניתן לבצע את הפעולה. ייתכן שהבקשה או הרשאות השליחה השתנו; יש לרענן ולבדוק.",
      );
    } finally {
      setPending(false);
    }
  }
  const alerts = requests.filter((item) => item.needsAttention).length;
  return (
    <Surface level="raised" className="field-service-incomplete">
      <section dir="rtl" lang="he" aria-label="בקשות שלא הושלמו">
        <header>
          <h2>
            בקשות שלא הושלמו <Badge label={String(requests.length)} />
          </h2>
          {alerts > 0 ? (
            <p role="status">{alerts} בקשות ממתינות לטיפול מעל 15 דקות</p>
          ) : null}
        </header>
        {error ? <p role="alert">{error}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {!loaded ? (
          <p>טוענת בקשות…</p>
        ) : requests.length === 0 ? (
          <p>אין בקשות פתוחות שממתינות להשלמת הטופס.</p>
        ) : (
          <ul className="field-service-incomplete-list">
            {requests.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.customerName}</strong> ·{" "}
                  <bdi dir="ltr">
                    {item.recipient ?? "מספר מאומת אינו זמין"}
                  </bdi>
                </div>
                <p>{item.reason}</p>
                <p>
                  המתנה: {item.waitingMinutes} דקות · נוצרה:{" "}
                  {new Date(item.createdAt).toLocaleString("he-IL")}
                </p>
                <small>
                  סטטוס ספק:{" "}
                  {(
                    {
                      sent: "נשלחה",
                      delivered: "נמסרה",
                      read: "נקראה",
                      failed: "נכשלה",
                      queued: "בתור",
                      sending: "תוצאה טרם ידועה",
                      not_sent: "לא נשלחה",
                    } as Record<string, string>
                  )[item.delivery] ?? "טרם נצפה"}
                  .{" "}
                  {item.openedAt
                    ? "נצפתה פתיחת הטופס."
                    : "לא נצפתה פתיחת הטופס."}
                </small>
                {canManage ? (
                  <div className="field-service-incomplete-actions">
                    {item.actions.map((selected) => (
                      <Button
                        key={selected}
                        variant="secondary"
                        onClick={() => {
                          setError("");
                          setAction({
                            intakeId: item.id,
                            action: selected,
                            operationId: crypto.randomUUID(),
                          });
                        }}
                      >
                        {labels[selected]}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <ConfirmDialog
          open={action !== undefined}
          title={action ? labels[action.action] : "אישור פעולה"}
          description="הפעולה תיבדק שוב מול מצב הבקשה והרשאות השליחה. אישור אינו מבטיח שהודעה נמסרה."
          confirmLabel="אישור"
          cancelLabel="ביטול"
          busy={pending}
          onConfirm={() => void confirm()}
          onCancel={() => {
            if (!pending) setAction(undefined);
          }}
        />
      </section>
    </Surface>
  );
}
