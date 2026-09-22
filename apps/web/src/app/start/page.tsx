import Link from "next/link";
import { redirect } from "next/navigation";
import { applicationHome } from "@or-on/auth";
import { getTranslations } from "next-intl/server";
import { ArrowUpRight, Workflow } from "lucide-react";

import { Badge, PageHeader } from "@or-on/ui";

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
  // Workspace onboarding is not part of the technician application.
  if (session.applicationScope === "field-service")
    redirect(applicationHome["field-service"]);
  const t = await getTranslations("start");
  const tCommon = await getTranslations("common");
  const tInbox = await getTranslations("inbox");
  const tManagement = await getTranslations("management");
  const tPages = await getTranslations("pages");
  const entry = await getTranslations("premiumEntry");
  const hasPermission = (permission: string) =>
    session.permissions.includes(permission);
  const steps = [
    {
      body: hasPermission("tenant:manage")
        ? t("workspaceBody")
        : tManagement("noPermission"),
      canAct: hasPermission("tenant:manage"),
      href: "/settings",
      key: "workspace",
      visible: hasPermission("platform:read"),
    },
    {
      body: hasPermission("crm:write")
        ? t("contactsBody")
        : tPages("contactsDescription"),
      canAct: hasPermission("crm:write"),
      href: "/contacts",
      key: "contacts",
      visible: hasPermission("crm:read"),
    },
    {
      body: hasPermission("messaging:operate")
        ? t("inboxBody")
        : tInbox("readOnly"),
      canAct: hasPermission("messaging:operate"),
      href: "/inbox",
      key: "inbox",
      visible: hasPermission("crm:read"),
    },
    {
      body: tPages("pipelinesDescription"),
      canAct: hasPermission("pipelines:manage"),
      href: "/pipelines",
      key: "next",
      visible: hasPermission("crm:read"),
    },
  ] as const;
  return (
    <main aria-labelledby="start-title" className="page page--wide start-page">
      <PageHeader
        description={t("description")}
        eyebrow={t("eyebrow")}
        title={<span id="start-title">{t("title")}</span>}
      />
      <div className="start-workspace">
        <aside className="start-introduction">
          <Workflow size={28} aria-hidden="true" />
          <h2>{entry("startQuestion")}</h2>
          <p>{entry("startHint")}</p>
          <span>
            {entry("availableWorkflows", {
              count: steps.filter((step) => step.visible).length,
            })}
          </span>
        </aside>
        <ol aria-label={t("available")} className="getting-started">
          {steps
            .filter((step) => step.visible)
            .map((step) => (
              <li key={step.key}>
                <div>
                  <h2>{t(step.key)}</h2>
                  <p>{step.body}</p>
                  <Badge
                    label={step.canAct ? t("available") : tCommon("readOnly")}
                    tone={step.canAct ? "info" : "neutral"}
                  />
                </div>
                {step.canAct ? (
                  <Link
                    className="or-button or-button--secondary action-link"
                    href={step.href}
                  >
                    {t("open")}
                    <ArrowUpRight aria-hidden="true" size={15} />
                  </Link>
                ) : null}
              </li>
            ))}
        </ol>
      </div>
      <p className="public-note">{t("help")}</p>
    </main>
  );
}
