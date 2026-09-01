export function assertTrustedUnsafeRequest(request: Request): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const requestUrl = new URL(request.url);
  const present = (value: string | undefined): string | undefined =>
    value === "" ? undefined : value;
  const expectedHost =
    present(request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()) ??
    present(request.headers.get("host")?.trim()) ??
    requestUrl.host;
  const expectedProtocol =
    present(request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()) ??
    requestUrl.protocol.slice(0, -1);
  let suppliedOrigin: URL;
  try {
    suppliedOrigin = new URL(origin ?? "");
  } catch {
    throw new TypeError("unsafe request origin is not trusted");
  }
  if (
    suppliedOrigin.host !== expectedHost ||
    suppliedOrigin.protocol !== `${expectedProtocol}:`
  ) {
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
  if (forwarded !== undefined && forwarded !== "") return forwarded;
  const direct = request.headers.get("x-real-ip")?.trim();
  return direct === "" ? undefined : direct;
}
