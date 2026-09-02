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
  const payload = await responsePayload(response);
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

export async function responsePayload(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(
      response.status === 401
        ? "Your session expired. Sign in again."
        : "The server returned an unexpected response. Refresh and try again; your draft has been kept.",
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error(
      "The server response could not be read. Your draft has been kept.",
    );
  }
}

export async function crmRead<T>(
  url: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    url,
    signal === undefined
      ? { cache: "no-store" }
      : { signal, cache: "no-store" },
  );
  const payload = await responsePayload(response);
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Your session expired. Sign in again."
        : "Could not refresh this view. Please try again.",
    );
  return payload as T;
}
