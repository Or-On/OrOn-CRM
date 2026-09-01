import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

import { AppShell } from "../features/shell";
import { currentPublicSession } from "../features/auth";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "Or-On Platform", template: "%s · Or-On Platform" },
  description:
    "Unified operator platform foundation for voice, messaging, CRM, and live agents.",
};

export default async function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const session = await currentPublicSession();
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <AppShell session={session}>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
