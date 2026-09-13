import { Buffer } from "node:buffer";

import { NextResponse } from "next/server";

import { generateOpaqueToken, hashOpaqueToken } from "@or-on/auth";
import { loadConfig } from "@or-on/config";
import { createTenantInvitation } from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (
      typeof body.email !== "string" ||
      (body.role !== "admin" && body.role !== "agent" && body.role !== "viewer")
    ) {
      throw new TypeError("invalid invitation");
    }
    const config = loadConfig(process.env, {
      requireAuth: true,
      service: "web",
    });
    const pepper = config.secrets.authTokenPepper;
    if (pepper === undefined)
      throw new Error("validated authentication configuration is incomplete");
    const token = generateOpaqueToken();
    const tokenHash = Buffer.from(hashOpaqueToken(token, pepper)).toString(
      "hex",
    );
    const invitationId = await withCurrentTenant("members:manage", (sql) =>
      createTenantInvitation(sql, {
        email: body.email as string,
        role: body.role as "admin" | "agent" | "viewer",
        tokenHash,
        requestId: requestId(request),
      }),
    );
    return NextResponse.json({ invitationId, token }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
