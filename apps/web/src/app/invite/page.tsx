import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Surface } from "@or-on/ui";

import { withAuthService } from "../../features/auth";
import { EntryStory } from "../../features/brand";
import { LanguageControl } from "../../i18n/language-control";
import { ThemeControl } from "../../i18n/theme-control";
import { AcceptInvitationForm } from "./accept-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("invitation");
  return {
    title: t("metadata"),
    robots: { index: false, follow: false },
  };
}

export default async function InvitationPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly token?: string }>;
}) {
  const token = (await searchParams).token ?? "";
  const invitation = await withAuthService((service) =>
    service.inspectInvitation(token),
  );
  const t = await getTranslations("invitation");
  const status = await getTranslations("status");
  return (
    <main className="invite-page">
      <header className="invite-header">
        <div className="login-preferences">
          <LanguageControl />
          <ThemeControl />
        </div>
      </header>
      <div className="invite-body">
        <EntryStory />
        <Surface className="invite-card" level="raised">
          {invitation === undefined ? (
            <>
              <h1>{t("unavailable")}</h1>
              <p>{t("unavailableHint")}</p>
              <Link className="text-link" href="/login">
                {t("returnToSignIn")}
              </Link>
            </>
          ) : (
            <>
              <span className="invite-card__eyebrow">{t("eyebrow")}</span>
              <h1>{t("title", { tenant: invitation.tenantName })}</h1>
              <p>
                {t("description", {
                  email: invitation.email,
                  role: status(invitation.role),
                })}
              </p>
              <AcceptInvitationForm
                existingAccount={invitation.existingAccount}
                token={token}
              />
            </>
          )}
        </Surface>
      </div>
    </main>
  );
}
