"use client";
import { useTranslations } from "next-intl";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import { Button, InlineFeedback, Input } from "@or-on/ui";

export function LoginForm() {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: data.get("email"),
          password: data.get("password"),
        }),
      });
      if (!response.ok) {
        setError(
          t(
            response.status === 401 || response.status === 400
              ? "auth.invalid"
              : "auth.failed",
          ),
        );
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError(t("auth.failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="login-form" onSubmit={(event) => void submit(event)}>
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
      {error === undefined ? null : (
        <InlineFeedback description={error} tone="critical" />
      )}
      <Button busy={pending} type="submit">
        {pending ? t("auth.pending") : t("auth.submit")}
      </Button>
    </form>
  );
}
