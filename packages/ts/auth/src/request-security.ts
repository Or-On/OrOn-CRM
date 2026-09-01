export function assertTrustedUnsafeRequest(request: Request): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const expected = new URL(request.url).origin;
  if (origin === null || origin !== expected) {
    throw new TypeError("unsafe request origin is not trusted");
  }
  if (
    fetchSite !== null &&
    fetchSite !== "same-origin" &&
    fetchSite !== "same-site"
  ) {
    throw new TypeError("cross-site unsafe request rejected");
  }
}

export function clientAddress(request: Request): string | undefined {
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || undefined;
}
