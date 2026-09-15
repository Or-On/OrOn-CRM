export function tenantDateFormatter(
  locale: string,
  timeZone: string,
  options: Omit<Intl.DateTimeFormatOptions, "timeZone">,
): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // Tenant creation and settings now validate IANA names, but older imports
    // or an externally corrupted row must not turn an otherwise usable page
    // into the global error boundary. UTC is deterministic on server and client.
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
  }
}
