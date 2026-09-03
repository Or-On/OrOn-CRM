import { useTranslations } from "next-intl";

export function ProductHeading({ page }: { readonly page: string }) {
  const t = useTranslations("pages");
  return (
    <header className="page-heading">
      <p className="eyebrow">{t(`${page}Eyebrow`)}</p>
      <h1>{t(`${page}Title`)}</h1>
      <p>{t(`${page}Description`)}</p>
    </header>
  );
}
