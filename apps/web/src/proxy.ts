import { NextResponse, type NextRequest } from "next/server";
import { resolveLocale } from "./i18n/direction";

export function proxy(request: NextRequest) {
  const pathLocale = request.nextUrl.pathname.split("/")[1];
  const locale = resolveLocale(
    pathLocale === "en" || pathLocale === "he"
      ? pathLocale
      : request.cookies.get("or_on_locale")?.value,
  );
  const requestHeaders = new Headers(request.headers);
  // Overwrite untrusted incoming metadata; this is never an auth/tenant boundary.
  requestHeaders.set("x-or-on-locale", locale);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  if (
    (pathLocale === "en" || pathLocale === "he") &&
    request.cookies.get("or_on_locale")?.value !== pathLocale
  ) {
    response.cookies.set("or_on_locale", pathLocale, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 31536000,
      secure: request.nextUrl.protocol === "https:",
    });
  }
  return response;
}

export const config = { matcher: ["/((?!api|_next|favicon.ico|.*\\..*).*)"] };
