"use client";

export function csrfToken(): string {
  const prefix = "or_on_csrf=";
  const value = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(prefix));
  return value === undefined
    ? ""
    : decodeURIComponent(value.slice(prefix.length));
}

export async function crmMutation<T>(
  url: string,
  body: Record<string, unknown>,
  options: {
    readonly method?: "POST" | "PATCH" | "DELETE";
    readonly idempotencyKey?: string;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-csrf-token": csrfToken(),
  };
  if (options.idempotencyKey !== undefined)
    headers["idempotency-key"] = options.idempotencyKey;
  const response = await fetch(url, {
    method: options.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message =
      payload !== null &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : "Operation failed";
    throw new Error(message);
  }
  return payload as T;
}
