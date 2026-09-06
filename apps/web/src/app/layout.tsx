import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { directionForLocale, resolveLocale } from "../i18n/direction";
import { ConnectionStatus } from "../i18n/connection-status";
import { FormValidation } from "../i18n/form-validation";

import "./globals.css";

import { AppShell } from "../features/shell";
import { AccessProvider } from "../features/access";
import { currentPublicSession } from "../features/auth";
import { Providers } from "./providers";
import { product } from "../branding";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return {
    title: { default: product.name, template: `%s · ${product.name}` },
    description: t("description"),
  };
}

export default async function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const publicRoute =
    (await headers()).get("x-or-on-public-route") === "localized-root";
  const session = publicRoute ? undefined : await currentPublicSession();
  const locale = resolveLocale(await getLocale());
  return (
    <html
      lang={locale}
      dir={directionForLocale(locale)}
      suppressHydrationWarning
    >
      <body>
        <Providers>
          <NextIntlClientProvider>
            <ConnectionStatus />
            <AccessProvider permissions={session?.permissions ?? []}>
              <FormValidation>
                <AppShell session={session}>{children}</AppShell>
              </FormValidation>
            </AccessProvider>
          </NextIntlClientProvider>
        </Providers>
      </body>
    </html>
  );
}
