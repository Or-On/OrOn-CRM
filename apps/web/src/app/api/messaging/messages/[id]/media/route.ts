import { NextResponse } from "next/server";

import { getMessageMediaObjectMetadata } from "@or-on/crm";

import { withCurrentTenant } from "../../../../../../features/auth";
import { crmErrorResponse } from "../../../../../../features/crm-route";
import { readPrivateObject } from "../../../../../../features/private-objects";

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
  return encodeURIComponent(value).replace(
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
          : "pdf";
  return `whatsapp-${id}.${extension}`;
}

function nonEmptyName(value: string | null): string | undefined {
  const name = value?.trim();
  return name === undefined || name === "" ? undefined : name;
}

export async function GET(
  _request: Request,
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
        { status: 404 },
      );
    if (metadata.storageBackend !== "local")
      return NextResponse.json(
        { error: "The configured private object adapter is unavailable" },
        { status: 503 },
      );
    const bytes = await readPrivateObject(metadata.storageKey, metadata);
    const displayName =
      nonEmptyName(metadata.fileName) ??
      fallbackName(metadata.contentType, metadata.id);
    const name = dispositionName(displayName);
    const disposition = metadata.contentType.startsWith("image/")
      ? "inline"
      : "attachment";
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `${disposition}; filename="${name}"; filename*=UTF-8''${encodedDispositionName(displayName)}`,
        "content-length": String(bytes.byteLength),
        "content-security-policy": "default-src 'none'; sandbox",
        "content-type": metadata.contentType,
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
