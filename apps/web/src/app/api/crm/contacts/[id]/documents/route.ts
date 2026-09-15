import { NextResponse } from "next/server";
import {
  markCustomerDocumentAvailable,
  registerCustomerDocument,
} from "@or-on/crm";

import { withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import {
  commitPrivateObject,
  discardPrivateObject,
  stagePrivateObject,
  type StagedPrivateObject,
} from "../../../../../../features/private-objects";
import { optionalText, uuid } from "../../../../../../features/field-service";

const categories = [
  "general",
  "warranty",
  "invoice",
  "manual",
  "identity",
  "other",
] as const;

function documentCategory(value: FormDataEntryValue | null) {
  if (
    typeof value !== "string" ||
    !categories.includes(value as (typeof categories)[number])
  )
    throw new TypeError("Select a valid customer document category");
  return value as (typeof categories)[number];
}

function safeFileName(value: string): string {
  const leaf = value.split(/[\\/]/u).at(-1)?.trim() ?? "";
  if (leaf === "" || leaf.length > 240 || /\p{Cc}/u.test(leaf))
    throw new TypeError("Document name is invalid");
  return leaf;
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]/documents">,
) {
  let staged: StagedPrivateObject | undefined;
  try {
    await assertCrmMutation(request);
    const [{ id }, form] = await Promise.all([
      context.params,
      request.formData(),
    ]);
    const contactId = uuid(id, "Contact");
    const file = form.get("file");
    if (!(file instanceof File)) throw new TypeError("Select a document");
    const category = documentCategory(form.get("category"));
    const captionEntry = form.get("caption");
    const caption =
      typeof captionEntry === "string"
        ? optionalText(captionEntry, "Document caption")
        : undefined;
    const result = await withCurrentTenant(
      category === "identity" ? "customer-sensitive:write" : "crm:write",
      async (sql, session) => {
        staged = await stagePrivateObject({
          tenantId: session.tenant.tenantId,
          caseId: contactId,
          category,
          scope: "customer-files",
          declaredContentType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        const registered = await registerCustomerDocument(sql, session.userId, {
          contactId,
          displayName: safeFileName(file.name),
          category,
          ...(caption === undefined ? {} : { caption }),
          contentType: staged.contentType,
          byteSize: staged.byteSize,
          checksum: staged.checksum,
          storageBackend: staged.storageBackend,
          storageKey: staged.storageKey,
        });
        await commitPrivateObject(staged);
        if (!(await markCustomerDocumentAvailable(sql, registered.objectId)))
          throw new Error("Customer document could not be made available");
        return registered;
      },
    );
    // The transaction now owns the promoted object. Cleanup below is only for
    // failures that happened before the database commit completed.
    staged = undefined;
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (staged !== undefined)
      await discardPrivateObject(staged).catch(() => undefined);
    return crmErrorResponse(error);
  }
}
