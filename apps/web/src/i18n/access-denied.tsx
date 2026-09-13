import Link from "next/link";
import { useTranslations } from "next-intl";
import { ErrorState } from "@or-on/ui";
import { LockKeyhole } from "lucide-react";

export function AccessDenied() {
  const t = useTranslations();
  return (
    <main className="page route-state">
      <span className="route-state__symbol" aria-hidden="true">
        <LockKeyhole size={28} />
      </span>
      <ErrorState
        headingLevel={1}
        title={t("feedback.permissionTitle")}
        description={t("feedback.permissionDescription")}
        action={
          <Link className="or-button or-button--secondary action-link" href="/">
            {t("feedback.home")}
          </Link>
        }
      />
    </main>
  );
}
