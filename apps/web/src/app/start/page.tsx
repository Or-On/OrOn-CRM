import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { currentPublicSession } from "../../features/auth";

export async function generateMetadata() {
  return {
    title: (await getTranslations("start"))("title"),
    robots: { index: false, follow: false },
  };
}

export default async function StartPage() {
  const session = await currentPublicSession();
  if (!session) redirect("/login");
  const t = await getTranslations("start");
  const steps = [
    { key: "workspace", href: "/settings", permission: "platform:read" },
    { key: "contacts", href: "/contacts", permission: "crm:read" },
    { key: "inbox", href: "/inbox", permission: "crm:read" },
    { key: "next", href: "/pipelines", permission: "crm:read" },
  ] as const;
  return (
    <main className="page">
      <header className="page-heading">
        <p className="eyebrow">{t("eyebrow")}</p>
        <h1>{t("title")}</h1>
        <p>{t("description")}</p>
      </header>
      <ol className="getting-started">
        {steps
          .filter((step) => session.permissions.includes(step.permission))
          .map((step) => (
            <li key={step.key}>
              <div>
                <h2>{t(step.key)}</h2>
                <p>{t(`${step.key}Body`)}</p>
              </div>
              <Link
                className="or-button or-button--secondary action-link"
                href={step.href}
              >
                {t("open")}
              </Link>
            </li>
          ))}
      </ol>
      <p className="public-note">{t("help")}</p>
    </main>
  );
}
