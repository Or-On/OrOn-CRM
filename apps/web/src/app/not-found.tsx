import Link from "next/link";
import { useTranslations } from "next-intl";
import { House } from "lucide-react";

import { product } from "../branding";
import { BrandMark } from "../features/brand";

export default function NotFound() {
  const t = useTranslations("feedback");
  return (
    <main
      className="page route-state route-state--not-found"
      aria-labelledby="not-found-title"
    >
      <div className="not-found__brand" aria-label={product.name}>
        <BrandMark size={32} />
        <span>{product.name}</span>
      </div>
      <span className="not-found__code" aria-hidden="true">
        404
      </span>
      <span className="not-found__mark" aria-hidden="true">
        <BrandMark size={52} />
      </span>
      <section className="not-found__content">
        <p className="eyebrow">{t("notFoundEyebrow")}</p>
        <h1 id="not-found-title">{t("notFoundTitle")}</h1>
        <p>{t("notFoundDescription")}</p>
        <Link
          className="or-button or-button--primary or-button--medium"
          href="/"
        >
          <House aria-hidden="true" size={16} />
          {t("home")}
        </Link>
      </section>
    </main>
  );
}
