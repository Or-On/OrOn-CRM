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
  // Locale metadata is not an authentication boundary. Never trust caller headers.
  requestHeaders.set("x-or-on-locale", locale);
  requestHeaders.delete("x-or-on-public-route");
  // The requested page lets the root layout keep a session inside its own
  // application. It can only redirect away from a page; it never grants one.
  requestHeaders.set("x-or-on-pathname", request.nextUrl.pathname);
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
