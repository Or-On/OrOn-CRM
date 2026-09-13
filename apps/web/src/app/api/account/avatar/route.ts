import { NextResponse } from "next/server";

import { getCurrentUserAvatar, setCurrentUserAvatar } from "@or-on/crm";

import { requestId, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { readIdentityImage } from "../../../../features/identity";

export async function GET() {
  try {
    const image = await withCurrentTenant("platform:read", (sql) =>
      getCurrentUserAvatar(sql),
    );
    if (image === undefined) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(image.data), {
      headers: {
        "cache-control": "private, no-store",
        "content-type": image.contentType,
        "last-modified": new Date(image.updatedAt).toUTCString(),
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await assertCrmMutation(request);
    const image = await readIdentityImage(request);
    await withCurrentTenant("platform:read", (sql) =>
      setCurrentUserAvatar(sql, image, requestId(request)),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await assertCrmMutation(request);
    await withCurrentTenant("platform:read", (sql) =>
      setCurrentUserAvatar(sql, undefined, requestId(request)),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
