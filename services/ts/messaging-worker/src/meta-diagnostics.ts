import { metaErrorNumber, type WhatsAppSendDiagnostic } from "@or-on/crm";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Inspect bounded text only to recognize known explanations; never return it. */
export function metaDiagnostic(
  payload: unknown,
  httpStatus: number,
  retryable: boolean,
): WhatsAppSendDiagnostic {
  const error = record(record(payload).error);
  const code = metaErrorNumber(error.code);
  const subcode = metaErrorNumber(error.error_subcode);
  const details = record(error.error_data).details;
  const text = [error.message, details]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.slice(0, 4096).toLowerCase())
    .join(" ");
  let reason: WhatsAppSendDiagnostic["reason"] = "unknown";
  if (
    /hello_world|sample template/u.test(text) &&
    /test (?:phone )?number|test account/u.test(text)
  )
    reason = "test_template";
  else if (text.includes("apps with the capability")) reason = "app_capability";
  else if (
    (code === 100 && subcode === 33) ||
    /unsupported (?:get|post) request|cannot be loaded due to missing permissions/u.test(
      text,
    )
  )
    reason = "resource_access";
  else if (code === 190) reason = "authentication";
  else if (code === 10 || code === 200 || code === 131005)
    reason = "permission";
  else if (code === 132001) reason = "template_missing";
  else if (code === 132000 || code === 132012) reason = "template_parameters";
  else if (code === 131047) reason = "customer_service_window";
  else if (httpStatus === 429) reason = "rate_limit";
  else if (httpStatus >= 500) reason = "provider_unavailable";
  else if (code === 100) reason = "invalid_parameter";
  return {
    version: 1,
    httpStatus,
    metaCode: code,
    metaSubcode: subcode,
    reason,
    retryable,
  };
}
