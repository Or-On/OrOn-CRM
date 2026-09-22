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
    readonly method?: "POST" | "PUT" | "PATCH" | "DELETE";
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
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
    ...(options.signal === undefined ? {} : { signal: options.signal }),
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

export async function imageMutation<T>(
  url: string,
  options: {
    readonly file?: File;
    readonly method: "DELETE" | "PATCH";
  },
): Promise<T> {
  const body = new FormData();
  if (options.file !== undefined) body.set("image", options.file);
  const response = await fetch(url, {
    method: options.method,
    headers: { "x-csrf-token": csrfToken() },
    ...(options.method === "PATCH" ? { body } : {}),
  });
  const payload = await responsePayload(response);
  if (!response.ok) {
    const message =
      payload !== null &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : "Image update failed";
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

/** A failed read keeps a generic message and exposes the server's code. */
export class CrmReadError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code: string | undefined) {
    super(message);
    this.name = "CrmReadError";
    this.status = status;
    this.code = code;
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
    throw new CrmReadError(
      response.status === 401
        ? "Your session expired. Sign in again."
        : "Could not refresh this view. Please try again.",
      response.status,
      payload !== null &&
        typeof payload === "object" &&
        "code" in payload &&
        typeof payload.code === "string"
        ? payload.code
        : undefined,
    );
  return payload as T;
}
