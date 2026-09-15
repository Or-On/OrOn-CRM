import { NextResponse } from "next/server";
import { confirmOcrCorrections } from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";
import { uuid } from "../../../../../features/field-service";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

export async function PATCH(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    await withCurrentTenant("field-service:operate", (sql, session) =>
      confirmOcrCorrections(
        sql,
        session.userId,
        uuid(id, "OCR result"),
        body.fields,
        requestId(request),
      ),
    );
    return NextResponse.json({ confirmed: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
