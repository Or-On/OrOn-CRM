import { LoadingSkeleton } from "@or-on/ui";
import { useTranslations } from "next-intl";

export default function Loading() {
  const t = useTranslations("feedback");
  return (
    <main
      aria-busy="true"
      aria-label={t("loading")}
      className="page route-loading"
    >
      <div className="route-loading__heading">
        <LoadingSkeleton label={t("loading")} />
      </div>
      <div aria-hidden="true" className="route-loading__toolbar">
        <span className="or-skeleton" />
        <span className="or-skeleton" />
        <span className="or-skeleton" />
      </div>
      <div aria-hidden="true" className="route-loading__workspace">
        <span className="or-skeleton" />
        <span className="or-skeleton" />
        <span className="or-skeleton" />
      </div>
    </main>
  );
}
