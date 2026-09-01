import { randomUUID } from "node:crypto";

export function requestId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim().slice(0, 128);
  return supplied === undefined || supplied === "" ? randomUUID() : supplied;
}

export async function jsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > 16_384) {
    throw new TypeError("request body is too large");
  }
  const value: unknown = await request.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("request body must be an object");
  }
  return value as Record<string, unknown>;
}
