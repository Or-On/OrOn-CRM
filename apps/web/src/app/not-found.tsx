import Link from "next/link";
import { useTranslations } from "next-intl";

import { EmptyState } from "@or-on/ui";

export default function NotFound() {
  const t = useTranslations("feedback");
  return (
    <EmptyState
      action={
        <Link className="or-button or-button--primary" href="/">
          {t("home")}
        </Link>
      }
      description={t("notFoundDescription")}
      title={t("notFoundTitle")}
    />
  );
}
