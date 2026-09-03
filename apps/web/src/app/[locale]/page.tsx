import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { loadConfig } from "@or-on/config";
import { MarketingPage } from "../../features/marketing";

interface Props {
  readonly params: Promise<{ locale: string }>;
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (locale !== "en" && locale !== "he") notFound();
  const t = await getTranslations({ locale, namespace: "meta" });
  const config = loadConfig(process.env, { service: "web" });
  return {
    metadataBase: new URL(config.publicSiteUrl ?? "http://127.0.0.1:3000"),
    title: t("publicTitle"),
    description: t("description"),
    alternates: {
      canonical: `/${locale}`,
      languages: { en: "/en", he: "/he", "x-default": "/en" },
    },
    robots: {
      index: config.environment === "production",
      follow: config.environment === "production",
    },
    openGraph: {
      title: t("publicTitle"),
      description: t("description"),
      locale: locale === "he" ? "he_IL" : "en_US",
      alternateLocale: locale === "he" ? "en_US" : "he_IL",
      type: "website",
      url: `/${locale}`,
    },
    twitter: {
      card: "summary",
      title: t("publicTitle"),
      description: t("description"),
    },
  };
}
export default async function PublicPage({ params }: Props) {
  const { locale } = await params;
  if (locale !== "en" && locale !== "he") notFound();
  return <MarketingPage />;
}
