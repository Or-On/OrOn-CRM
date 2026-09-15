import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { currentPublicSession } from "../features/auth";

export const localizedEntryMetadata: Metadata = {
  robots: { index: false, follow: false },
};

export async function LocalizedEntryPage() {
  // The locale proxy persists the selected language before this redirect.
  redirect((await currentPublicSession()) === undefined ? "/login" : "/");
}
