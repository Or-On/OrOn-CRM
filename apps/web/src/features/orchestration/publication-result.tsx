"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@or-on/ui";
import { useCapability } from "../access";
import { crmMutation } from "../crm";
import { AgentGoldenEvaluations } from "./agent-golden-evaluations";
import styles from "./publication-workspace.module.css";

import type { PublicationResult as PublicationContract } from "@or-on/crm";
export type PublicationView = Pick<PublicationContract, "status" | "impacts"> &
  Partial<
    Pick<
      PublicationContract,
      "operationId" | "releaseId" | "evaluationCandidates"
    >
  >;
const labels: Readonly<Record<string, string>> = {
  active_for_new_interactions: "פעיל לשיחות חדשות",
  published_pending_activation: "פורסם, ממתין להפעלה",
  unchanged_pinned: "השיוך נעול לגרסה קודמת",
  blocked: "ההפעלה חסומה — נדרשת בדיקת תצורה",
  blocked_evaluation:
    "ממתין לבדיקת איכות של הגרסה המדויקת — המסלול הקודם נשאר פעיל",
};
export function PublicationResult({
  result: initial,
}: {
  readonly result: PublicationView;
}) {
  const generation = useRef(0);
  const [updated, setUpdated] = useState<PublicationView>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const canManage = useCapability("flows:manage");
  useEffect(() => {
    generation.current += 1;
    setUpdated(undefined);
    setFailed(false);
    setPending(false);
    return () => {
      generation.current += 1;
    };
  }, [initial]);
  const result = updated ?? initial;
  return (
    <section className={styles.inspector} dir="rtl" aria-label="תוצאת פרסום">
      <h3 role="status">{labels[result.status] ?? result.status}</h3>
      <p>
        שיחות שכבר התחילו נשארות בגרסתן. פרסום אינו מעביר שיחות WhatsApp קיימות.
      </p>
      <ul>
        {result.impacts.map((impact, index) => (
          <li key={`${impact.processName}-${impact.trigger}-${String(index)}`}>
            <strong>{impact.processName}</strong> · <bdi>{impact.trigger}</bdi>
            <p>
              {labels[impact.status] ?? impact.status}: {impact.reason}
            </p>
            <dl className={styles.metadata}>
              {Object.entries(impact)
                .filter(([key]) => key.endsWith("VersionId"))
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd dir="ltr">{value ?? "—"}</dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ul>
      {result.evaluationCandidates?.map((candidate) => (
        <div
          key={`${candidate.publicationOperationId}:${candidate.agentVersionId}`}
        >
          <p>
            טביעת הגרסה לבדיקה:{" "}
            <code dir="ltr">{candidate.candidateDigest}</code>
          </p>
          <AgentGoldenEvaluations
            endpoint={`/api/orchestration/agents/${candidate.agentProfileId}`}
            versionId={candidate.agentVersionId}
            publicationOperationId={candidate.publicationOperationId}
            locale="he"
          />
        </div>
      ))}
      {result.operationId &&
      (result.status === "published_pending_activation" ||
        result.status === "blocked_evaluation") ? (
        <Button
          disabled={!canManage}
          busy={pending}
          onClick={() => {
            setPending(true);
            setFailed(false);
            const current = generation.current;
            const operationId = result.operationId;
            if (!operationId) return;
            void crmMutation<{ publication: PublicationView }>(
              `/api/orchestration/publications/${operationId}/activate`,
              {},
            )
              .then((response) => {
                if (generation.current === current)
                  setUpdated(response.publication);
              })
              .catch(() => {
                if (generation.current === current) setFailed(true);
              })
              .finally(() => {
                if (generation.current === current) setPending(false);
              });
          }}
        >
          בדיקה מחדש והפעלת הגרסה שאושרה
        </Button>
      ) : null}
      {failed ? (
        <p role="alert">
          ההפעלה לא הושלמה. בדקו את ראיות האיכות ואישור התצורה; המסלול הקודם
          נשאר פעיל.
        </p>
      ) : null}
      {result.status !== "active_for_new_interactions" ? (
        <Link className="text-link" href="/settings/business">
          בדיקת שיוכים ואישור תצורה
        </Link>
      ) : null}
      {result.operationId ? (
        <small dir="ltr">{result.operationId}</small>
      ) : null}
    </section>
  );
}
