import { NextResponse } from "next/server";
import { getFieldServiceObjectMetadata } from "@or-on/crm";

import { withCurrentTenant } from "../../../../../features/auth";
import { crmErrorResponse } from "../../../../../features/crm-route";
import { readPrivateObject } from "../../../../../features/private-objects";
import { uuid } from "../../../../../features/field-service";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const metadata = await withCurrentTenant("field-service:read", (sql) =>
      getFieldServiceObjectMetadata(sql, uuid(id, "Attachment")),
    );
    if (metadata?.status !== "available")
      return NextResponse.json(
        { error: "Attachment not found" },
        { status: 404 },
      );
    if (metadata.storageBackend !== "local")
      return NextResponse.json(
        { error: "The configured private object adapter is unavailable" },
        { status: 503 },
      );
    const bytes = await readPrivateObject(metadata.storageKey, metadata);
    const disposition = metadata.contentType.startsWith("image/")
      ? "inline"
      : "attachment";
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `${disposition}; filename="${metadata.id}"`,
        "content-length": String(bytes.byteLength),
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
