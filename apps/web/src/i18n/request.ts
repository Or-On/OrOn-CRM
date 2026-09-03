import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { resolveLocale } from "./direction";

export default getRequestConfig(async () => {
  const locale = resolveLocale(
    (await headers()).get("x-or-on-locale") ??
      (await cookies()).get("or_on_locale")?.value,
  );
  return {
    locale,
    timeZone: "Asia/Jerusalem",
    messages:
      locale === "he"
        ? (await import("./messages/he.json")).default
        : (await import("./messages/en.json")).default,
  };
});
