import type { Metadata } from "next";
import { Geist, Geist_Mono, Heebo } from "next/font/google";
import { loadConfig } from "@or-on/config";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { directionForLocale, resolveLocale } from "../i18n/direction";
import { ConnectionStatus } from "../i18n/connection-status";
import { FormValidation } from "../i18n/form-validation";

import "./globals.css";
import "./workspace.css";
import "./workspace-features.css";
import "./workspace-details.css";
import "./inbox-workspace.css";
import "./auth.css";
import "./voice-details.css";
import "./studio-replica.css";
import "./workspace-premium.css";

import { AppShell } from "../features/shell";
import { AccessProvider } from "../features/access";
import { currentPublicSession } from "../features/auth";
import { Providers } from "./providers";
import { product } from "../branding";

import "@xyflow/react/dist/style.css";

const applicationLatin = Geist({
  display: "swap",
  subsets: ["latin"],
  variable: "--application-font-latin",
});

const applicationMono = Geist_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--application-font-mono",
});

const applicationHebrew = Heebo({
  display: "swap",
  subsets: ["hebrew"],
  variable: "--application-font-hebrew",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return {
    title: { default: product.name, template: `%s · ${product.name}` },
    description: t("description"),
    icons: {
      icon: [{ url: product.logoPath, type: "image/webp" }],
      shortcut: product.logoPath,
    },
  };
}

export default async function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const session = await currentPublicSession();
  const environment = loadConfig(process.env, { service: "web" }).environment;
  const locale = resolveLocale(await getLocale());
  return (
    <html
      lang={locale}
      dir={directionForLocale(locale)}
      suppressHydrationWarning
    >
      <body
        className={`${applicationLatin.variable} ${applicationMono.variable} ${applicationHebrew.variable}`}
      >
        <Providers>
          <NextIntlClientProvider>
            <ConnectionStatus />
            <AccessProvider permissions={session?.permissions ?? []}>
              <FormValidation>
                <AppShell environment={environment} session={session}>
                  {children}
                </AppShell>
              </FormValidation>
            </AccessProvider>
          </NextIntlClientProvider>
        </Providers>
      </body>
    </html>
  );
}
