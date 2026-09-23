import { NextResponse } from "next/server";
import {
  linkReportAttachment,
  markFieldServiceObjectAvailable,
  queueAttachmentOcr,
  registerFieldServiceObject,
} from "@or-on/crm";

import { withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import {
  commitPrivateObject,
  discardPrivateObject,
  stagePrivateObject,
  type StagedPrivateObject,
} from "../../../../features/private-objects";
import { uuid } from "../../../../features/field-service";

const categories = [
  "fault",
  "module",
  "product_label",
  "repair",
  "environment",
  "document",
  "customer_photo",
  "arrival_signature",
  "departure_signature",
  "before_photo",
  "after_photo",
  "tenant_document",
] as const;
type Category = (typeof categories)[number];

function category(value: FormDataEntryValue | null): Category {
  if (typeof value !== "string" || !categories.includes(value as Category))
    throw new TypeError("Select a valid attachment category");
  return value as Category;
}

function optionalUuid(value: FormDataEntryValue | null, label: string) {
  return value === null || value === "" ? undefined : uuid(value, label);
}

export async function POST(request: Request) {
  let staged: StagedPrivateObject | undefined;
  try {
    await assertCrmMutation(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new TypeError("Select a file to upload");
    const caseId = uuid(form.get("caseId"), "Case");
    const selectedCategory = category(form.get("category"));
    if (
      selectedCategory === "arrival_signature" ||
      selectedCategory === "departure_signature"
    )
      throw new TypeError(
        "Attendance signatures must be uploaded through the visit attendance action",
      );
    if (selectedCategory === "customer_photo")
      throw new TypeError(
        "Customer photos arrive from the customer's own messages",
      );
    const documentTypeEntry = form.get("documentType");
    const documentType =
      typeof documentTypeEntry === "string" && documentTypeEntry !== ""
        ? documentTypeEntry
        : undefined;
    if (
      (selectedCategory === "tenant_document") !==
        (documentType !== undefined) ||
      (documentType !== undefined &&
        !/^[a-z][a-z0-9_]{1,31}$/u.test(documentType))
    )
      throw new TypeError("Choose a configured document type");
    const visitId = optionalUuid(form.get("visitId"), "Visit");
    const reportRevisionId = optionalUuid(
      form.get("reportRevisionId"),
      "Report revision",
    );
    const captionEntry = form.get("caption");
    const caption = typeof captionEntry === "string" ? captionEntry : undefined;
    const result = await withCurrentTenant(
      "field-service:operate",
      async (sql, session) => {
        staged = await stagePrivateObject({
          tenantId: session.tenant.tenantId,
          caseId,
          category: selectedCategory,
          declaredContentType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        const objectId = await registerFieldServiceObject(sql, session.userId, {
          caseId,
          category: selectedCategory,
          contentType: staged.contentType,
          byteSize: staged.byteSize,
          checksum: staged.checksum,
          storageBackend: staged.storageBackend,
          storageKey: staged.storageKey,
        });
        await commitPrivateObject(staged);
        if (!(await markFieldServiceObjectAvailable(sql, objectId)))
          throw new Error("Attachment could not be marked available");
        const attachmentId = await linkReportAttachment(sql, session.userId, {
          caseId,
          ...(visitId === undefined ? {} : { visitId }),
          ...(reportRevisionId === undefined ? {} : { reportRevisionId }),
          objectId,
          category: selectedCategory,
          ...(documentType === undefined ? {} : { documentType }),
          source: "technician",
          ...(caption === undefined ? {} : { caption }),
        });
        const runOcr = form.get("runOcr") === "true";
        const ocrResultId =
          selectedCategory === "product_label" && runOcr
            ? await queueAttachmentOcr(sql, attachmentId, staged.checksum)
            : undefined;
        return { attachmentId, objectId, ocrResultId };
      },
    );
    // The database transaction and object promotion are now durable. Do not
    // let a later response-construction failure remove an available object.
    staged = undefined;
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (staged !== undefined)
      await discardPrivateObject(staged).catch(() => undefined);
    return crmErrorResponse(error);
  }
}
