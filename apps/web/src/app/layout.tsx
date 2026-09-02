import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

import { AppShell } from "../features/shell";
import { currentPublicSession } from "../features/auth";
import { Providers } from "./providers";
import { product } from "../branding";

export const metadata: Metadata = {
  title: { default: product.name, template: `%s · ${product.name}` },
  description: product.description,
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
