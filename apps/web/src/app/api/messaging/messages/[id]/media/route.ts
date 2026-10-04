import { NextResponse } from "next/server";

import { getMessageMediaObjectMetadata } from "@or-on/crm";

import { withCurrentTenant } from "../../../../../../features/auth";
import { crmErrorResponse } from "../../../../../../features/crm-route";
import { readPrivateObject } from "../../../../../../features/private-objects";
import { selectPrivateByteRange } from "../../../../../../features/private-media";

function messageId(value: string): string {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(value))
    throw new TypeError("Invalid message reference");
  return value;
}

function dispositionName(value: string): string {
  return (
    value.replace(/[^\x20-\x7e]|["\\]/gu, "_").slice(0, 240) || "attachment"
  );
}

function encodedDispositionName(value: string): string {
  return encodeURIComponent(
    Array.from(value.replace(/[\uD800-\uDFFF]/gu, "_"))
      .slice(0, 160)
      .join(""),
  ).replace(
    /[!'()*]/gu,
    (character) =>
      `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ""}`,
  );
}

function fallbackName(contentType: string, id: string): string {
  const extension =
    contentType === "image/jpeg"
      ? "jpg"
      : contentType === "image/png"
        ? "png"
        : contentType === "image/webp"
          ? "webp"
          : contentType === "audio/ogg"
            ? "ogg"
            : contentType === "audio/wav"
              ? "wav"
              : contentType === "video/mp4"
                ? "mp4"
                : contentType === "text/plain"
                  ? "txt"
                  : "pdf";
  return `whatsapp-${id}.${extension}`;
}

function nonEmptyName(value: string | null): string | undefined {
  const name = value?.trim();
  return name === undefined || name === "" ? undefined : name;
}

export async function GET(
  request: Request,
  context: RouteContext<"/api/messaging/messages/[id]/media">,
) {
  try {
    const { id } = await context.params;
    const metadata = await withCurrentTenant("crm:read", (sql) =>
      getMessageMediaObjectMetadata(sql, messageId(id)),
    );
    if (metadata?.status !== "available")
      return NextResponse.json(
        { error: "Message attachment not found" },
        { status: 404, headers: { "cache-control": "private, no-store" } },
      );
    if (metadata.storageBackend !== "local")
      return NextResponse.json(
        { error: "The configured private object adapter is unavailable" },
        { status: 503, headers: { "cache-control": "private, no-store" } },
      );
    const maximum: Readonly<Record<string, number>> = {
      "image/jpeg": 12 * 1024 * 1024,
      "image/png": 12 * 1024 * 1024,
      "image/webp": 12 * 1024 * 1024,
      "application/pdf": 20 * 1024 * 1024,
      "text/plain": 2 * 1024 * 1024,
      "audio/ogg": 16 * 1024 * 1024,
      "audio/wav": 16 * 1024 * 1024,
      "video/mp4": 16 * 1024 * 1024,
    };
    const limit = maximum[metadata.contentType];
    if (
      limit === undefined ||
      !Number.isSafeInteger(metadata.byteSize) ||
      metadata.byteSize < 1 ||
      metadata.byteSize > limit
    )
      return NextResponse.json(
        { error: "Message attachment not found" },
        { status: 404, headers: { "cache-control": "private, no-store" } },
      );
    // Integrity validation precedes even range errors; no partial unverified file.
    const bytes = await readPrivateObject(metadata.storageKey, metadata);
    const displayName =
      nonEmptyName(metadata.fileName) ??
      fallbackName(metadata.contentType, metadata.id);
    const name = dispositionName(displayName);
    const disposition =
      metadata.contentType.startsWith("image/") ||
      metadata.contentType === "audio/ogg" ||
      metadata.contentType === "audio/wav" ||
      metadata.contentType === "video/mp4"
        ? "inline"
        : "attachment";
    const headers = {
      "cache-control": "private, no-store",
      "content-disposition": `${disposition}; filename="${name}"; filename*=UTF-8''${encodedDispositionName(displayName)}`,
      "accept-ranges": "bytes",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": metadata.contentType,
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    };
    // No validators are issued: If-Range and HEAD use the complete response.
    const range = selectPrivateByteRange(
      request.method === "GET" && !request.headers.has("if-range")
        ? request.headers.get("range")
        : null,
      bytes.byteLength,
    );
    if (range.kind === "unsatisfiable")
      return new NextResponse(null, {
        status: 416,
        headers: {
          ...headers,
          "content-range": `bytes */${String(bytes.byteLength)}`,
          "content-length": "0",
        },
      });
    if (range.kind === "partial")
      return new NextResponse(
        Buffer.from(bytes.subarray(range.start, range.end + 1)),
        {
          status: 206,
          headers: {
            ...headers,
            "content-range": `bytes ${String(range.start)}-${String(range.end)}/${String(bytes.byteLength)}`,
            "content-length": String(range.end - range.start + 1),
          },
        },
      );
    return new NextResponse(Buffer.from(bytes), {
      headers: { ...headers, "content-length": String(bytes.byteLength) },
    });
  } catch (error) {
    const response = crmErrorResponse(error);
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
}
