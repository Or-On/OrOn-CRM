import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { LanguageControl } from "../../i18n/language-control";

import { Surface } from "@or-on/ui";

import { currentPublicSession } from "../../features/auth";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getTranslations("meta"))("signIn"),
    robots: { index: false, follow: false },
  };
}

export default async function LoginPage() {
  if ((await currentPublicSession()) !== undefined) redirect("/");
  const t = await getTranslations("auth");
  const locale = await getLocale();
  return (
    <main className="login-page">
      <Surface className="login-card" level="raised">
        <div className="section-heading">
          <span className="eyebrow">{t("eyebrow")}</span>
          <LanguageControl />
        </div>
        <h1>{t("title")}</h1>
        <p>{t("description")}</p>
        <LoginForm />
        <details className="access-help">
          <summary>{t("help")}</summary>
          <p>{t("helpText")}</p>
        </details>
        <p className="login-trust">{t("trust")}</p>
        <Link className="text-link" href={`/${locale}`}>
          {t("back")}
        </Link>
      </Surface>
    </main>
  );
}
