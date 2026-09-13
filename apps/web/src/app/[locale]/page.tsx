import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { currentPublicSession } from "../../features/auth";

interface Props {
  readonly params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (locale !== "en" && locale !== "he") notFound();
  return { robots: { index: false, follow: false } };
}

export default async function LocalizedEntryPage({ params }: Props) {
  const { locale } = await params;
  if (locale !== "en" && locale !== "he") notFound();
  // The locale proxy persists the selected language before this redirect.
  redirect((await currentPublicSession()) === undefined ? "/login" : "/");
}
