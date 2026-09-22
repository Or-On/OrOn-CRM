import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { applicationHome } from "@or-on/auth";

import { currentPublicSession } from "../features/auth";

export const localizedEntryMetadata: Metadata = {
  robots: { index: false, follow: false },
};

export async function LocalizedEntryPage() {
  // The locale proxy persists the selected language before this redirect.
  const session = await currentPublicSession();
  redirect(
    session === undefined
      ? "/login"
      : session.applicationScope === "field-service"
        ? applicationHome["field-service"]
        : applicationHome.workspace,
  );
}
