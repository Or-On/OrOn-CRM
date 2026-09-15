import { NextResponse } from "next/server";
import { isAuthorized } from "@or-on/auth";
import {
  archiveCustomerDocument,
  getCustomerDocumentObjectMetadata,
} from "@or-on/crm";

import {
  ForbiddenError,
  withCurrentTenant,
} from "../../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../../features/crm-route";
import { readPrivateObject } from "../../../../../../../features/private-objects";
import { uuid } from "../../../../../../../features/field-service";

function dispositionName(value: string): string {
  return value.replace(/["\\\p{Cc}]/gu, "_").slice(0, 240) || "document";
}

export async function GET(
  _request: Request,
  context: RouteContext<"/api/crm/contacts/[id]/documents/[documentId]">,
) {
  try {
    const { id, documentId } = await context.params;
    const metadata = await withCurrentTenant(
      "crm:read",
      async (sql, session) => {
        const result = await getCustomerDocumentObjectMetadata(
          sql,
          uuid(id, "Contact"),
          uuid(documentId, "Document"),
        );
        if (
          result?.category === "identity" &&
          !isAuthorized(
            { role: session.tenant.role, isSuperuser: session.isSuperuser },
            "customer-sensitive:read",
          )
        )
          throw new ForbiddenError("Sensitive customer-document access denied");
        return result;
      },
    );
    if (metadata?.status !== "available")
      return NextResponse.json(
        { error: "Document not found" },
        { status: 404 },
      );
    if (metadata.storageBackend !== "local")
      return NextResponse.json(
        { error: "The configured private object adapter is unavailable" },
        { status: 503 },
      );
    const bytes = await readPrivateObject(metadata.storageKey, metadata);
    const name = dispositionName(metadata.displayName);
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(metadata.displayName)}`,
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

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]/documents/[documentId]">,
) {
  try {
    await assertCrmMutation(request);
    const { id, documentId } = await context.params;
    const archived = await withCurrentTenant(
      "crm:write",
      async (sql, session) => {
        const contactId = uuid(id, "Contact");
        const selectedDocumentId = uuid(documentId, "Document");
        const metadata = await getCustomerDocumentObjectMetadata(
          sql,
          contactId,
          selectedDocumentId,
        );
        if (
          metadata?.category === "identity" &&
          !isAuthorized(
            { role: session.tenant.role, isSuperuser: session.isSuperuser },
            "customer-sensitive:write",
          )
        )
          throw new ForbiddenError("Sensitive customer-document access denied");
        return archiveCustomerDocument(
          sql,
          session.userId,
          contactId,
          selectedDocumentId,
        );
      },
    );
    if (!archived)
      return NextResponse.json(
        { error: "Document not found" },
        { status: 404 },
      );
    return NextResponse.json({ archived: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
