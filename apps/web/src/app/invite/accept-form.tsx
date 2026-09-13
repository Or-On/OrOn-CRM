"use client";

import { Button, InlineFeedback, Input } from "@or-on/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

export function AcceptInvitationForm({
  existingAccount,
  token,
}: {
  readonly existingAccount: boolean;
  readonly token: string;
}) {
  const t = useTranslations("invitation");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function accept(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          ...(existingAccount
            ? {}
            : {
                displayName: data.get("displayName"),
                password: data.get("password"),
              }),
        }),
      });
      const result = (await response.json()) as { readonly signedIn?: boolean };
      if (!response.ok) throw new Error(t("failed"));
      router.replace(
        result.signedIn === true ? "/" : "/login?invitation=accepted",
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="invite-form" onSubmit={(event) => void accept(event)}>
      {existingAccount ? (
        <p>{t("existingAccount")}</p>
      ) : (
        <>
          <Input
            autoComplete="name"
            id="invitation-display-name"
            label={t("displayName")}
            name="displayName"
            maxLength={120}
          />
          <Input
            autoComplete="new-password"
            id="invitation-password"
            label={t("password")}
            minLength={12}
            name="password"
            required
            type="password"
          />
        </>
      )}
      {error === undefined ? null : (
        <InlineFeedback description={error} tone="critical" />
      )}
      <Button busy={pending} type="submit">
        {t("join")}
      </Button>
    </form>
  );
}
