"use client";
import { useTranslations } from "next-intl";

import { useRouter } from "next/navigation";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";

import { Button, InlineFeedback, Input } from "@or-on/ui";

export function LoginForm() {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const submitterRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (pending) return;
    const submitter = submitterRef.current;
    submitterRef.current = null;
    if (
      submitter?.isConnected &&
      !submitter.matches(":disabled") &&
      document.activeElement === document.body
    ) {
      submitter.focus();
    }
  }, [pending]);
  const [challenge, setChallenge] = useState<{
    id: string;
    phoneHint: string;
  }>();

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    submitterRef.current =
      submitter instanceof HTMLButtonElement &&
      document.activeElement === submitter
        ? submitter
        : null;
    setPending(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch(
        challenge === undefined ? "/api/auth/login" : "/api/auth/sms",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            challenge === undefined
              ? {
                  email: data.get("email"),
                  password: data.get("password"),
                }
              : { id: challenge.id, code: data.get("code") },
          ),
        },
      );
      if (!response.ok) {
        setError(
          t(
            challenge !== undefined
              ? "smsVerification.failed"
              : response.status === 401 || response.status === 400
                ? "auth.invalid"
                : "auth.failed",
          ),
        );
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as {
        readonly home?: unknown;
        readonly smsChallenge?: { id: string; phoneHint: string };
      };
      if (payload.smsChallenge !== undefined) {
        setChallenge(payload.smsChallenge);
        return;
      }
      // Technicians land directly in their Field Service application.
      router.replace(
        payload.home === "/field-service" ? "/field-service" : "/",
      );
      router.refresh();
    } catch {
      setError(
        t(challenge === undefined ? "auth.failed" : "smsVerification.failed"),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="login-form" onSubmit={(event) => void submit(event)}>
      {challenge === undefined ? (
        <Fragment key="credentials">
          <Input
            autoComplete="email"
            id="email"
            label={t("auth.email")}
            name="email"
            required
            type="email"
            dir="ltr"
          />
          <Input
            autoComplete="current-password"
            id="password"
            label={t("auth.password")}
            name="password"
            required
            type="password"
          />
        </Fragment>
      ) : (
        <Fragment key="sms-challenge">
          <p>{t("smsVerification.sent", { phone: challenge.phoneHint })}</p>
          <Input
            autoComplete="one-time-code"
            autoFocus
            id="code"
            name="code"
            label={t("smsVerification.code")}
            inputMode="numeric"
            pattern="[0-9]{6}"
            minLength={6}
            maxLength={6}
            required
            dir="ltr"
          />
          <Button
            type="button"
            disabled={pending}
            variant="secondary"
            onClick={() => {
              setChallenge(undefined);
              setError(undefined);
            }}
          >
            {t("smsVerification.restart")}
          </Button>
        </Fragment>
      )}
      {error === undefined ? null : (
        <InlineFeedback description={error} tone="critical" />
      )}
      <Button busy={pending} type="submit">
        {pending
          ? t("auth.pending")
          : challenge === undefined
            ? t("auth.submit")
            : t("smsVerification.verify")}
      </Button>
    </form>
  );
}
