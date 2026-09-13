"use client";

import type {
  VoiceControlCommand,
  VoiceControlStatus,
} from "@or-on/api-client";
import { Button, ConfirmDialog, SectionHeader, Surface } from "@or-on/ui";
import { useLocale } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { csrfToken } from "./mutation";
import styles from "./voice-ai-controls.module.css";

const copy = {
  en: {
    title: "AI in this call",
    scope:
      "Controls only the AI in this existing call. This does not connect a person or start another call.",
    loading: "Checking worker status…",
    awaiting:
      "Waiting for a current worker acknowledgement. No control command is recorded.",
    failed:
      "Could not verify the current worker status. No new command was sent.",
    pendingPause: "Pause requested; waiting for worker acknowledgement.",
    pendingResume: "Resume requested; waiting for worker acknowledgement.",
    paused: "The worker has acknowledged that AI is paused.",
    ai: "The worker has acknowledged that AI is active.",
    unavailable:
      "The worker is unavailable or has not checked in. AI state is not confirmed.",
    inactive: "This call is no longer active. Controls are unavailable.",
    viewOnly:
      "Read-only access. A current operator permission is required to change AI state.",
    stale:
      "Another change was recorded. Current status was reloaded; your command was not retried.",
    unknown:
      "The command result is uncertain. Check current status before retrying the same request.",
    refused:
      "The command was refused. Current status must be checked before another action.",
    pause: "Pause AI",
    resume: "Resume AI",
    resumeTitle: "Resume AI in this call?",
    resumeDescription:
      "This may restart AI speech and paid processing in the existing call. It does not connect a person or create another call.",
    cancel: "Keep current state",
    check: "Check status",
    retry: "Retry the same request",
    recovery: "An explicit resume is required before AI can continue.",
  },
  he: {
    title: "AI בשיחה הזאת",
    scope:
      "הבקרה משפיעה רק על ה-AI בשיחה הקיימת. היא לא מחברת נציג ולא מתחילה שיחה נוספת.",
    loading: "בודקים את מצב רכיב השיחה…",
    awaiting: "ממתינים לאישור עדכני מרכיב השיחה. לא נרשמה פקודת בקרה.",
    failed: "לא ניתן לאמת את המצב הנוכחי. לא נשלחה פקודה חדשה.",
    pendingPause: "בקשת ההשהיה נרשמה; ממתינים לאישור מרכיב השיחה.",
    pendingResume: "בקשת החידוש נרשמה; ממתינים לאישור מרכיב השיחה.",
    paused: "רכיב השיחה אישר שה-AI מושהה.",
    ai: "רכיב השיחה אישר שה-AI פעיל.",
    unavailable:
      "רכיב השיחה אינו זמין או שלא דיווח לאחרונה. מצב ה-AI אינו מאומת.",
    inactive: "השיחה כבר אינה פעילה. הבקרה אינה זמינה.",
    viewOnly: "גישה לצפייה בלבד. שינוי מצב ה-AI דורש הרשאת הפעלה עדכנית.",
    stale: "נרשם שינוי אחר. המצב נטען מחדש; הפקודה שלך לא נשלחה שוב.",
    unknown:
      "תוצאת הפקודה אינה ודאית. יש לבדוק את המצב לפני ניסיון חוזר של אותה בקשה.",
    refused: "הפקודה נדחתה. יש לבדוק את המצב לפני פעולה נוספת.",
    pause: "השהיית AI",
    resume: "חידוש AI",
    resumeTitle: "לחדש AI בשיחה הזאת?",
    resumeDescription:
      "הפעולה עשויה לחדש דיבור ועיבוד AI בתשלום בשיחה הקיימת. היא לא מחברת נציג ולא יוצרת שיחה נוספת.",
    cancel: "שמירת המצב הנוכחי",
    check: "בדיקת מצב",
    retry: "ניסיון חוזר של אותה בקשה",
    recovery: "נדרש חידוש מפורש לפני שה-AI יוכל להמשיך.",
  },
} as const;

function parseStatus(value: unknown, sessionId: string): VoiceControlStatus {
  if (value === null || typeof value !== "object")
    throw new Error("invalid control status");
  const data = value as Partial<VoiceControlStatus>;
  if (
    data.session_id !== sessionId ||
    !Number.isSafeInteger(data.epoch) ||
    typeof data.epoch !== "number" ||
    data.epoch < 0 ||
    (data.desired_mode !== "ai" && data.desired_mode !== "paused") ||
    (data.worker_mode !== "ai" &&
      data.worker_mode !== "paused" &&
      data.worker_mode !== null) ||
    (data.acknowledged_epoch !== null &&
      (!Number.isSafeInteger(data.acknowledged_epoch) ||
        typeof data.acknowledged_epoch !== "number" ||
        data.acknowledged_epoch < 0)) ||
    (data.acknowledged_at !== null &&
      typeof data.acknowledged_at !== "string") ||
    (data.command_id !== null && typeof data.command_id !== "string") ||
    (data.status !== "applied" &&
      data.status !== "pending" &&
      data.status !== "worker_unavailable") ||
    typeof data.active !== "boolean" ||
    typeof data.can_operate !== "boolean" ||
    typeof data.resume_required !== "boolean" ||
    data.human_connection !== "not_managed" ||
    (data.status === "applied" &&
      (data.acknowledged_epoch !== data.epoch ||
        data.worker_mode !== data.desired_mode))
  )
    throw new Error("invalid control status");
  return data as VoiceControlStatus;
}

/** Keying this lifetime prevents a prior tenant/session response affecting a new call. */
export function VoiceAIControls({
  sessionId,
  active,
  provider,
}: {
  readonly sessionId: string;
  readonly active: boolean;
  readonly provider: string;
}) {
  if (!active || provider === "simulator") return null;
  return <ActiveVoiceAIControls key={sessionId} sessionId={sessionId} />;
}

function ActiveVoiceAIControls({ sessionId }: { readonly sessionId: string }) {
  const text = copy[useLocale() === "he" ? "he" : "en"];
  const [snapshot, setSnapshot] = useState<VoiceControlStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<"stale" | "unknown" | "refused" | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const [retryAllowed, setRetryAllowed] = useState(false);
  const operations = useRef<{
    refresh: () => Promise<void>;
    send: (mode: "ai" | "paused", retry?: boolean) => Promise<void>;
  } | null>(null);

  useEffect(() => {
    let stopped = false;
    const isStopped = () => stopped;
    let terminal = false;
    let reading = false;
    let sending = false;
    let revision = 0;
    let current: VoiceControlStatus | null = null;
    let unresolved: VoiceControlCommand | null = null;
    let checkedUnresolved = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requests = new Set<AbortController>();
    const path = `/api/voice/sessions/${encodeURIComponent(sessionId)}/control`;

    async function request(init?: RequestInit) {
      const controller = new AbortController();
      requests.add(controller);
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch(path, {
          ...init,
          cache: "no-store",
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        return { response, payload };
      } finally {
        clearTimeout(timeout);
        requests.delete(controller);
      }
    }

    function accept(next: VoiceControlStatus) {
      if (current && current.epoch !== next.epoch) setConfirmResume(false);
      current = next;
      terminal = !next.active;
      setSnapshot(next);
      setFailed(false);
      if (!next.can_operate) {
        unresolved = null;
        checkedUnresolved = false;
        setRetryAllowed(false);
        setConfirmResume(false);
      }
    }

    async function refresh() {
      if (stopped || terminal || reading || sending) return;
      reading = true;
      const ownRevision = revision;
      try {
        const { response, payload } = await request();
        if (isStopped() || ownRevision !== revision) return;
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) {
            terminal = true;
            current = null;
            setSnapshot(null);
            setConfirmResume(false);
          }
          throw new Error("control status unavailable");
        }
        const next = parseStatus(payload, sessionId);
        accept(next);
        if (unresolved) {
          if (next.epoch > unresolved.expected_epoch) {
            unresolved = null;
            checkedUnresolved = false;
            setRetryAllowed(false);
            setNotice("stale");
          } else {
            checkedUnresolved = next.epoch === unresolved.expected_epoch;
            setRetryAllowed(
              checkedUnresolved && next.can_operate && next.active,
            );
          }
        }
      } catch {
        if (!isStopped() && ownRevision === revision) {
          checkedUnresolved = false;
          setRetryAllowed(false);
          setFailed(true);
        }
      } finally {
        reading = false;
      }
    }

    async function send(mode: "ai" | "paused", retry = false) {
      if (
        stopped ||
        terminal ||
        sending ||
        !current?.active ||
        !current.can_operate
      )
        return;
      if (unresolved && (!retry || !checkedUnresolved)) return;
      if (retry && !unresolved) return;
      const command: VoiceControlCommand = unresolved ?? {
        mode,
        expected_epoch: current.epoch,
        idempotency_key: `voice-control:${crypto.randomUUID()}`,
      };
      unresolved = command;
      checkedUnresolved = false;
      sending = true;
      revision += 1;
      setBusy(true);
      setRetryAllowed(false);
      setNotice(null);
      setConfirmResume(false);
      try {
        const { response, payload } = await request({
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfToken(),
          },
          body: JSON.stringify(command),
        });
        if (isStopped()) return;
        if (response.status === 409) {
          unresolved = null;
          setFailed(true);
          setNotice("stale");
        } else if ([400, 401, 403, 404, 422].includes(response.status)) {
          unresolved = null;
          current = null;
          setSnapshot(null);
          setNotice("refused");
          if ([401, 403, 404].includes(response.status)) terminal = true;
        } else if (!response.ok) {
          throw new Error("uncertain control result");
        } else {
          const next = parseStatus(payload, sessionId);
          if (next.epoch <= command.expected_epoch)
            throw new Error("missing command receipt");
          unresolved = null;
          accept(next);
        }
      } catch {
        if (!isStopped()) setNotice("unknown");
      } finally {
        sending = false;
        if (!isStopped()) {
          setBusy(false);
          await refresh();
        }
      }
    }

    function schedule() {
      if (stopped || terminal) return;
      timer = setTimeout(() => {
        if (document.visibilityState === "hidden") schedule();
        else void refresh().finally(schedule);
      }, 2_000);
    }
    function visible() {
      if (document.visibilityState !== "hidden") void refresh();
    }
    operations.current = { refresh, send };
    if (document.visibilityState !== "hidden") void refresh();
    schedule();
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      operations.current = null;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      requests.forEach((controller) => controller.abort());
    };
  }, [sessionId]);

  const statusText = !snapshot
    ? failed
      ? text.failed
      : text.loading
    : !snapshot.active
      ? text.inactive
      : snapshot.status === "worker_unavailable"
        ? text.unavailable
        : snapshot.status === "pending"
          ? snapshot.command_id == null
            ? text.awaiting
            : snapshot.desired_mode === "paused"
              ? text.pendingPause
              : text.pendingResume
          : snapshot.worker_mode === "paused"
            ? text.paused
            : text.ai;
  const disabled = busy || failed || notice === "unknown";
  return (
    <Surface className={styles.controls}>
      <SectionHeader title={text.title} description={text.scope} />
      <p role="status" aria-live="polite">
        {statusText}
      </p>
      {notice ? <p role="alert">{text[notice]}</p> : null}
      {snapshot && failed ? <p role="alert">{text.failed}</p> : null}
      {snapshot?.resume_required ? <p>{text.recovery}</p> : null}
      {snapshot && !snapshot.can_operate ? <p>{text.viewOnly}</p> : null}
      <div className={styles.actions}>
        {snapshot?.active && snapshot.can_operate ? (
          <>
            <Button
              disabled={disabled || snapshot.desired_mode === "paused"}
              variant="secondary"
              onClick={() => void operations.current?.send("paused")}
            >
              {text.pause}
            </Button>
            <Button
              disabled={
                disabled ||
                (snapshot.status === "pending" && !snapshot.resume_required) ||
                (snapshot.desired_mode === "ai" &&
                  !snapshot.resume_required &&
                  snapshot.status !== "worker_unavailable")
              }
              onClick={() => setConfirmResume(true)}
            >
              {text.resume}
            </Button>
          </>
        ) : null}
        {failed || notice === "unknown" ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void operations.current?.refresh()}
          >
            {text.check}
          </Button>
        ) : null}
        {retryAllowed ? (
          <Button
            disabled={busy}
            onClick={() => void operations.current?.send("paused", true)}
          >
            {text.retry}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={
          confirmResume && Boolean(snapshot?.active && snapshot.can_operate)
        }
        title={text.resumeTitle}
        description={text.resumeDescription}
        confirmLabel={text.resume}
        cancelLabel={text.cancel}
        busy={busy}
        confirmDisabled={disabled}
        onCancel={() => setConfirmResume(false)}
        onConfirm={() => void operations.current?.send("ai")}
      />
    </Surface>
  );
}
