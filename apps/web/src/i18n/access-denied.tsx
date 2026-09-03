import Link from "next/link";
import { useTranslations } from "next-intl";
import { ErrorState } from "@or-on/ui";

export function AccessDenied() {
  const t = useTranslations();
  return (
    <main className="page">
      <ErrorState
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
