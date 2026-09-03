import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";

export async function productMetadata(page: string): Promise<Metadata> {
  return {
    title: (await getTranslations("pages"))(`${page}Title`),
    robots: { index: false, follow: false },
  };
}
