import { LoadingSkeleton } from "@or-on/ui";
import { useTranslations } from "next-intl";

export default function Loading() {
  const t = useTranslations("feedback");
  return (
    <main aria-label={t("loading")}>
      <LoadingSkeleton label={t("loading")} />
    </main>
  );
}
