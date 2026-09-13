import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ProductHeading } from "../../../i18n/product-heading";
import { redirect } from "next/navigation";

import { HealthPanel } from "../../../features/system-health";
import { currentPublicSession } from "../../../features/auth";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getTranslations("pages"))("healthTitle"),
    robots: { index: false, follow: false },
  };
}

export default async function SystemHealthPage() {
  if ((await currentPublicSession()) === undefined) redirect("/login");
  return (
    <main className="page page--health page--workspace-premium">
      <ProductHeading page="health" premium />
      <HealthPanel />
    </main>
  );
}
