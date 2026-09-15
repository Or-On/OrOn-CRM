import { NextResponse } from "next/server";
import {
  beginVisitAttendanceRequest,
  linkReportAttachment,
  markFieldServiceObjectAvailable,
  registerFieldServiceObject,
  signVisitAttendance,
} from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../../../features/auth";
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
import { uuid } from "../../../../../../features/field-service";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

function attendanceKind(value: unknown): "arrival" | "departure" {
  if (value !== "arrival" && value !== "departure")
    throw new TypeError("Attendance kind must be arrival or departure");
  return value;
}

export async function POST(request: Request, context: Context) {
  let staged: StagedPrivateObject | undefined;
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const visitId = uuid(id, "Visit");
    const suppliedOperationKey = request.headers.get("idempotency-key")?.trim();
    const operationKey =
      suppliedOperationKey === undefined || suppliedOperationKey === ""
        ? requestId(request)
        : suppliedOperationKey;
    const isMultipart = request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("multipart/form-data");

    if (!isMultipart) {
      const body = await jsonObject(request);
      const kind = attendanceKind(body.kind);
      const visit = await withCurrentTenant(
        "field-service:operate",
        async (sql, session) =>
          (await beginVisitAttendanceRequest(sql, {
            visitId,
            kind,
            requestId: operationKey,
          })) ??
          signVisitAttendance(sql, {
            authSessionId: session.sessionId,
            visitId,
            signatureObjectId: uuid(body.signatureObjectId, "Signature"),
            kind,
            requestId: operationKey,
          }),
      );
      return NextResponse.json({ visit });
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File))
      throw new TypeError("Select a signature image");
    const kind = attendanceKind(form.get("kind"));
    const caseId = uuid(form.get("caseId"), "Case");
    const result = await withCurrentTenant(
      "field-service:operate",
      async (sql, session) => {
        const prior = await beginVisitAttendanceRequest(sql, {
          visitId,
          kind,
          requestId: operationKey,
        });
        if (prior !== undefined) {
          return {
            visit: prior,
            objectId:
              kind === "arrival"
                ? prior.arrivalSignatureObjectId
                : prior.departureSignatureObjectId,
            replayed: true,
          };
        }
        staged = await stagePrivateObject({
          tenantId: session.tenant.tenantId,
          caseId,
          category: `${kind}_signature`,
          declaredContentType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        const objectId = await registerFieldServiceObject(sql, session.userId, {
          caseId,
          category: `${kind}_signature`,
          contentType: staged.contentType,
          byteSize: staged.byteSize,
          checksum: staged.checksum,
          storageBackend: staged.storageBackend,
          storageKey: staged.storageKey,
        });
        await commitPrivateObject(staged);
        if (!(await markFieldServiceObjectAvailable(sql, objectId)))
          throw new Error("Signature evidence could not be made available");
        await linkReportAttachment(sql, session.userId, {
          caseId,
          visitId,
          objectId,
          category: `${kind}_signature`,
          source: "technician",
        });
        const visit = await signVisitAttendance(sql, {
          authSessionId: session.sessionId,
          visitId,
          signatureObjectId: objectId,
          kind,
          requestId: operationKey,
        });
        return { visit, objectId, replayed: false };
      },
    );
    staged = undefined;
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    if (staged !== undefined)
      await discardPrivateObject(staged).catch(() => undefined);
    return crmErrorResponse(error);
  }
}
