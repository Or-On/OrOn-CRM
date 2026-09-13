import { PageHeader } from "@or-on/ui";
import { useTranslations } from "next-intl";

export function ProductHeading({
  page,
  premium = false,
}: {
  readonly page: string;
  readonly premium?: boolean;
}) {
  const t = useTranslations("pages");
  return (
    <PageHeader
      className={`page-heading${premium ? " page-heading--premium" : ""}`}
      description={t(`${page}Description`)}
      eyebrow={t(`${page}Eyebrow`)}
      title={t(`${page}Title`)}
    />
  );
}
