/** Versioned, allowlisted diagnostics. Never a container for raw provider text. */
export const whatsAppFailureReasons = [
  "invalid_parameter",
  "app_capability",
  "resource_access",
  "test_template",
  "template_missing",
  "template_parameters",
  "customer_service_window",
  "permission",
  "authentication",
  "rate_limit",
  "provider_unavailable",
  "unknown",
] as const;

export interface WhatsAppSendDiagnostic {
  readonly version: 1;
  readonly httpStatus: number;
  readonly metaCode: number | null;
  readonly metaSubcode: number | null;
  readonly reason: (typeof whatsAppFailureReasons)[number];
  readonly retryable: boolean;
}

export interface MessageDeliveryFailure {
  readonly code: string;
  readonly diagnostic: WhatsAppSendDiagnostic | null;
}

export function metaErrorNumber(value: unknown): number | null {
  const number =
    typeof value === "string" && /^\d{1,10}$/u.test(value)
      ? Number(value)
      : value;
  return typeof number === "number" &&
    Number.isInteger(number) &&
    number >= 0 &&
    number <= 2_147_483_647
    ? number
    : null;
}

export function parseWhatsAppSendDiagnostic(
  value: unknown,
): WhatsAppSendDiagnostic | null {
  if (value === null || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const reason = whatsAppFailureReasons.find((item) => item === data.reason);
  if (
    data.version !== 1 ||
    typeof data.httpStatus !== "number" ||
    !Number.isInteger(data.httpStatus) ||
    data.httpStatus < 100 ||
    data.httpStatus > 599 ||
    typeof data.retryable !== "boolean" ||
    reason === undefined
  )
    return null;
  // Construct a new projection, never spread untrusted JSON into API results.
  return {
    version: 1,
    httpStatus: data.httpStatus,
    metaCode: metaErrorNumber(data.metaCode),
    metaSubcode: metaErrorNumber(data.metaSubcode),
    reason,
    retryable: data.retryable,
  };
}

const localErrorCodes = new Set([
  "provider_disabled",
  "provider_not_configured",
  "meta_http_error",
  "invalid_meta_response",
  "timeout",
  "network_error",
  "retry_exhausted",
  "outbound_processing_failed",
  "delivery_outcome_unknown",
  "sender_configuration_changed",
  "outbound_eligibility_changed",
  "ai_evidence_changed",
  "ai_evidence_invalid",
  "ai_trigger_superseded",
  "stale_worker_claim",
  "simulation_disabled",
]);

export function messageDeliveryFailure(
  code: unknown,
  diagnostic: unknown,
): MessageDeliveryFailure | null {
  if (typeof code !== "string" || code.length === 0) return null;
  const meta = /^meta_(\d{1,10})$/u.exec(code);
  const safeCode =
    localErrorCodes.has(code) ||
    (meta !== null && metaErrorNumber(meta[1]) !== null)
      ? code
      : "outbound_processing_failed";
  return {
    code: safeCode,
    diagnostic: parseWhatsAppSendDiagnostic(diagnostic),
  };
}
