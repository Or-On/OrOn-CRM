"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentGoldenWorkspace, AgentGoldenState } from "@or-on/crm";
import { Button, Select } from "@or-on/ui";
import { useCapability } from "../access";
import { crmMutation, crmRead } from "../crm";

export function AgentGoldenEvaluations({
  endpoint,
  versionId,
  locale,
  publicationOperationId,
}: {
  readonly publicationOperationId?: string;
  readonly endpoint: string;
  readonly versionId: string;
  readonly locale: string;
}) {
  const he = locale === "he";
  const canRequest = useCapability("flows:manage");
  const title = he
    ? "בדיקת איכות על שיחות אמיתיות"
    : "Real conversation quality evaluation";
  const [workspace, setWorkspace] = useState<AgentGoldenWorkspace>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef(true);
  const request = useRef<AbortController | undefined>(undefined);
  const url = `${endpoint}/golden-evaluations?versionId=${encodeURIComponent(versionId)}${publicationOperationId ? `&publicationOperationId=${encodeURIComponent(publicationOperationId)}` : ""}`;
  const labels: Record<AgentGoldenState, string> = he
    ? {
        blocked: "ממתין לסט שיחות אמיתיות ולמדיניות בדיקה שנבדקו",
        pending: "ממתין לבדיקה",
        running: "הבדיקה מתבצעת",
        failed: "הבדיקה נכשלה",
        passed: "נשמרה ראיה לבדיקה; תוקפה נבדק שוב בעת פרסום",
        stale: "הראיות אינן עדכניות",
      }
    : {
        blocked: "Awaiting reviewed real conversations and evaluator policy",
        pending: "Pending evaluation",
        running: "Evaluation running",
        failed: "Evaluation failed",
        passed: "Receipt recorded; publication rechecks its validity",
        stale: "Evidence is outdated",
      };

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    request.current = controller;
    void crmRead<AgentGoldenWorkspace>(url, controller.signal)
      .then((value) => {
        if (active.current && !controller.signal.aborted) setWorkspace(value);
      })
      .catch(() => {
        if (active.current && !controller.signal.aborted) setFailed(true);
      });
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, [url]);

  if (workspace?.enabled !== true && !failed) return null;
  return (
    <section className="feature-form" aria-label={title}>
      <h4>{title}</h4>
      {failed ? (
        <p role="alert">
          {he
            ? "מצב הבדיקה אינו זמין. לא הוכח שהבדיקה הושלמה."
            : "Evaluation status is unavailable. Completion has not been verified."}
        </p>
      ) : null}
      {workspace?.enabled === true ? (
        <>
          <p>
            {he
              ? "בקשה מוסיפה בדיקה לתור; היא אינה מוכיחה שהמודל הופעל או שהבדיקה הצליחה. הפעלת ספק דורשת עובד בדיקה מורשה ותקציב שאושר."
              : "A request queues an evaluation; it does not prove the model ran or the suite passed. Provider execution requires an authorized evaluation worker and approved budget."}
          </p>
          {workspace.datasets.length === 0 ? (
            <p role="status">{labels.blocked}</p>
          ) : null}
          <form
            className="feature-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canRequest || pending || workspace.datasets.length === 0)
                return;
              const form = new FormData(event.currentTarget);
              request.current?.abort();
              const controller = new AbortController();
              request.current = controller;
              setPending(true);
              setFailed(false);
              void crmMutation<{ id: string }>(
                `${endpoint}/golden-evaluations`,
                {
                  versionId,
                  datasetId: form.get("datasetId"),
                  ...(publicationOperationId ? { publicationOperationId } : {}),
                },
                { signal: controller.signal },
              )
                .then(() =>
                  crmRead<AgentGoldenWorkspace>(url, controller.signal),
                )
                .then((value) => {
                  if (active.current && !controller.signal.aborted)
                    setWorkspace(value);
                })
                .catch(() => {
                  if (active.current && !controller.signal.aborted)
                    setFailed(true);
                })
                .finally(() => {
                  if (active.current && request.current === controller)
                    setPending(false);
                });
            }}
          >
            <Select
              id={`golden-dataset-${versionId}`}
              name="datasetId"
              label={
                he
                  ? "גרסת סט שיחות שאושרה"
                  : "Approved conversation dataset revision"
              }
              disabled={
                !canRequest || pending || workspace.datasets.length === 0
              }
              required
            >
              {workspace.datasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.rubricVersion} ·{" "}
                  {new Date(dataset.approvedAt).toLocaleDateString(locale)}
                </option>
              ))}
            </Select>
            <Button
              type="submit"
              busy={pending}
              disabled={!canRequest || workspace.datasets.length === 0}
            >
              {he
                ? "בקשת הרצת סט השיחות שאושר"
                : "Request approved golden set run"}
            </Button>
          </form>
          {workspace.evaluations.length > 0 ? (
            <ul aria-live="polite">
              {workspace.evaluations.map((evaluation) => (
                <li key={evaluation.id}>
                  {labels[evaluation.state]} ·{" "}
                  {he ? "תוקף הראיות" : "Evidence expires"}:{" "}
                  <time dateTime={evaluation.expiresAt}>
                    {new Date(evaluation.expiresAt).toLocaleString(locale)}
                  </time>
                </li>
              ))}
            </ul>
          ) : null}
          <Button
            variant="quiet"
            disabled={pending}
            onClick={() => {
              const controller = new AbortController();
              request.current?.abort();
              request.current = controller;
              setPending(true);
              setFailed(false);
              void crmRead<AgentGoldenWorkspace>(url, controller.signal)
                .then((value) => {
                  if (active.current && !controller.signal.aborted)
                    setWorkspace(value);
                })
                .catch(() => {
                  if (active.current && !controller.signal.aborted)
                    setFailed(true);
                })
                .finally(() => {
                  if (active.current && request.current === controller)
                    setPending(false);
                });
            }}
          >
            {he ? "רענון מצב הבדיקה" : "Refresh evaluation status"}
          </Button>
        </>
      ) : null}
    </section>
  );
}
