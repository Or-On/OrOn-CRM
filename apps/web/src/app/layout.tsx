import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

import { AppShell } from "../features/shell";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "Or-On Platform", template: "%s · Or-On Platform" },
  description:
    "Unified operator platform foundation for voice, messaging, CRM, and live agents.",
};

export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
