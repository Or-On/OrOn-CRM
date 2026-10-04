"use client";

import { Fragment, useEffect, useState, type SyntheticEvent } from "react";
import { useTranslations } from "next-intl";
import {
  Button,
  InlineFeedback,
  Input,
  SectionHeader,
  Surface,
} from "@or-on/ui";
import { useMutationFocus } from "../keyboard";

export function SmsSecurity() {
  const t = useTranslations("smsVerification");
  const [status, setStatus] = useState<{
    available: boolean;
    phoneHint: string | null;
  }>();
  const [challenge, setChallenge] = useState<{
    id: string;
    phoneHint: string;
  }>();
  const [pending, setPending] = useState(false);
  const rememberFocus = useMutationFocus(pending);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  async function refresh() {
    const response = await fetch("/api/account/sms", { cache: "no-store" });
    if (!response.ok) throw new Error("SMS status unavailable");
    setStatus(
      (await response.json()) as {
        available: boolean;
        phoneHint: string | null;
      },
    );
  }
  useEffect(() => {
    void refresh().catch(() => setError(true));
  }, []);
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    rememberFocus();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(false);
    setSaved(false);
    try {
      const csrf =
        document.cookie
          .split("; ")
          .find((item) => item.startsWith("or_on_csrf="))
          ?.slice("or_on_csrf=".length) ?? "";
      const response = await fetch("/api/account/sms", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": decodeURIComponent(csrf),
        },
        body: JSON.stringify({
          action: challenge === undefined ? "start" : "complete",
          purpose:
            status?.phoneHint == null ? "staff_enrollment" : "staff_disable",
          ...(challenge === undefined
            ? { password: form.get("password"), phone: form.get("phone") }
            : { id: challenge.id, code: form.get("code") }),
        }),
      });
      if (!response.ok) throw new Error("SMS verification failed");
      const result = (await response.json()) as {
        challenge?: { id: string; phoneHint: string };
      };
      if (result.challenge !== undefined) setChallenge(result.challenge);
      else {
        setChallenge(undefined);
        setSaved(true);
        await refresh();
      }
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <Surface className="settings-form-surface" level="raised">
      <SectionHeader title={t("title")} description={t("staffHint")} />
      {error ? (
        <InlineFeedback tone="critical" description={t("failed")} />
      ) : null}
      {saved ? (
        <InlineFeedback tone="positive" description={t("saved")} />
      ) : null}
      {status === undefined ? (
        error ? null : (
          <p role="status">{t("loading")}</p>
        )
      ) : (
        <>
          <p>
            {status.phoneHint === null
              ? t("notEnrolled")
              : t("enrolled", { phone: status.phoneHint })}
          </p>
          {status.available ? (
            <form
              className="feature-form"
              onSubmit={(event) => void submit(event)}
            >
              <fieldset className="form-fieldset" disabled={pending}>
                {challenge === undefined ? (
                  <Fragment key="credentials">
                    {status.phoneHint === null ? (
                      <Input
                        id="sms-phone"
                        name="phone"
                        label={t("phone")}
                        type="tel"
                        autoComplete="tel"
                        placeholder="+972501234567"
                        pattern="\+[1-9][0-9]{7,14}"
                        required
                        dir="ltr"
                      />
                    ) : null}
                    <Input
                      id="sms-password"
                      name="password"
                      label={t("password")}
                      type="password"
                      autoComplete="current-password"
                      required
                    />
                  </Fragment>
                ) : (
                  <Fragment key="sms-challenge">
                    <p>{t("sent", { phone: challenge.phoneHint })}</p>
                    <Input
                      autoFocus
                      id="sms-code"
                      name="code"
                      label={t("code")}
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      minLength={6}
                      maxLength={6}
                      required
                      dir="ltr"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setChallenge(undefined)}
                    >
                      {t("restart")}
                    </Button>
                  </Fragment>
                )}
                <Button busy={pending} type="submit">
                  {challenge === undefined
                    ? status.phoneHint === null
                      ? t("enable")
                      : t("disable")
                    : t("verify")}
                </Button>
              </fieldset>
            </form>
          ) : (
            <InlineFeedback description={t("unavailable")} />
          )}
        </>
      )}
    </Surface>
  );
}
