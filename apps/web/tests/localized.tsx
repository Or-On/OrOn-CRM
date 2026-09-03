import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { permissions, type Permission } from "@or-on/auth";
import { AccessProvider } from "../src/features/access";
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";

export function localized(
  node: ReactNode,
  locale: "en" | "he" = "en",
  grants: readonly Permission[] = permissions,
) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "he" ? he : en}
      timeZone="Asia/Jerusalem"
      onError={(error) => {
        throw error;
      }}
    >
      <AccessProvider permissions={grants}>{node}</AccessProvider>
    </NextIntlClientProvider>
  );
}
export function renderMarkup(node: ReactNode, locale: "en" | "he" = "en") {
  return renderToStaticMarkup(localized(node, locale));
}
