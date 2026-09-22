import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LockKeyhole } from "lucide-react";
import { applicationHome } from "@or-on/auth";

import { Surface } from "@or-on/ui";

import { LanguageControl } from "../../i18n/language-control";
import { ThemeControl } from "../../i18n/theme-control";
import { currentPublicSession } from "../../features/auth";
import { EntryStory } from "../../features/brand";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getTranslations("meta"))("signIn"),
    robots: { index: false, follow: false },
  };
}

export default async function LoginPage() {
  const session = await currentPublicSession();
  // A signed-in technician belongs in the Field Service app, not the workspace.
  if (session !== undefined)
    redirect(
      session.applicationScope === "field-service"
        ? applicationHome["field-service"]
        : applicationHome.workspace,
    );
  const t = await getTranslations("auth");
  return (
    <main className="login-page">
      <header className="login-header">
        <div className="login-preferences">
          <LanguageControl />
          <ThemeControl />
        </div>
      </header>
      <div className="login-body">
        <EntryStory />
        <Surface
          className="login-access"
          level="raised"
          aria-labelledby="login-title"
        >
          <div className="login-access__heading">
            <span className="login-eyebrow">{t("eyebrow")}</span>
            <h1 id="login-title">{t("title")}</h1>
            <p>{t("description")}</p>
          </div>
          <LoginForm />
          <details className="access-help">
            <summary>{t("help")}</summary>
            <p>{t("helpText")}</p>
          </details>
          <p className="login-trust">
            <LockKeyhole size={14} aria-hidden="true" />
            {t("trust")}
          </p>
        </Surface>
      </div>
      <footer className="login-footer">
        <span>Or-On Platform</span>
        <span>{t("footer")}</span>
      </footer>
    </main>
  );
}
