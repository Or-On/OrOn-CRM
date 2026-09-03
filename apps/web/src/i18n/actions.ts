"use server";

import { cookies } from "next/headers";
import { supportedLocales, type SupportedLocale } from "./direction";

export async function changeLocale(locale: SupportedLocale): Promise<void> {
  if (!supportedLocales.includes(locale))
    throw new TypeError("Unsupported locale");
  (await cookies()).set("or_on_locale", locale, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 31536000,
    secure: process.env.NODE_ENV === "production",
  });
}
