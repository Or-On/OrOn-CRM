import type { Metadata } from "next";
import { Geist, Geist_Mono, Heebo } from "next/font/google";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { applicationHome, isPathInApplicationScope } from "@or-on/auth";
import { loadConfig } from "@or-on/config";
import { cache, type ReactNode } from "react";
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
import "./field-service.css";

import { AppShell } from "../features/shell";
import { AccessProvider } from "../features/access";
import { currentPublicSession, withCurrentShellTenant } from "../features/auth";
import {
  getFieldServiceFeatureState,
  getTenantFeatureSnapshot,
  getTenantSettings,
} from "@or-on/crm";
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

const currentShellContext = cache(async () => {
  const session = await currentPublicSession();
  if (session === undefined) return undefined;
  const presentation = await withCurrentShellTenant(async (sql) => {
    const settings = await getTenantSettings(sql);
    const [fieldService, features] = await Promise.all([
      session.permissions.includes("field-service:read")
        ? getFieldServiceFeatureState(sql)
        : undefined,
      getTenantFeatureSnapshot(sql),
    ]);
    return {
      businessName: settings.businessName ?? session.tenant.tenantName,
      accentToken: settings.accentToken ?? null,
      fieldServiceEnabled: fieldService?.effective === true,
      enabledFeatures: Object.values(features)
        .filter((feature) => feature.effective)
        .map((feature) => feature.key),
    };
  });
  return { session, ...presentation };
});

export async function generateMetadata(): Promise<Metadata> {
  const [t, shellContext] = await Promise.all([
    getTranslations("meta"),
    currentShellContext(),
  ]);
  const titleBrand = shellContext?.businessName ?? product.name;
  return {
    title: { default: titleBrand, template: `%s · ${titleBrand}` },
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
  const shellContext = await currentShellContext();
  const session = shellContext?.session;
  if (session !== undefined && session.applicationScope !== "workspace") {
    // A technician works inside the Field Service application. Page guards
    // and APIs deny everything else; a direct visit lands on the app home.
    const pathname = (await headers()).get("x-or-on-pathname");
    if (
      pathname !== null &&
      !isPathInApplicationScope(session.applicationScope, pathname)
    )
      redirect(applicationHome[session.applicationScope]);
  }
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
                <AppShell
                  environment={environment}
                  fieldServiceEnabled={
                    shellContext?.fieldServiceEnabled === true
                  }
                  enabledFeatures={shellContext?.enabledFeatures}
                  session={session}
                  {...(shellContext === undefined
                    ? {}
                    : {
                        tenantBranding: {
                          businessName: shellContext.businessName,
                          accentToken: shellContext.accentToken,
                        },
                      })}
                >
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
