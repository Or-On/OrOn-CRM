import { randomUUID } from "node:crypto";

export function requestId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim().slice(0, 128);
  return supplied === undefined || supplied === "" ? randomUUID() : supplied;
}

export async function jsonObject(
  request: Request,
  options: { readonly maximumBytes?: number } = {},
): Promise<Record<string, unknown>> {
  // Only route code chooses the bound; never derive it from request data.
  const maximumBytes = options.maximumBytes ?? 16_384;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 131_072
  )
    throw new TypeError("request body limit is invalid");
  const declared = request.headers.get("content-length");
  if (
    declared &&
    (!/^[0-9]+$/.test(declared) || Number(declared) > maximumBytes)
  ) {
    throw new TypeError("request body is too large");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("request body must be an object");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new TypeError("request body is too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, size),
      ),
    );
  } catch {
    throw new TypeError("request body must contain valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("request body must be an object");
  }
  return value as Record<string, unknown>;
}
