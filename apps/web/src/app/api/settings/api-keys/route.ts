import { NextResponse } from "next/server";

import { createApiKey } from "@or-on/crm";
import { loadConfig } from "@or-on/config";

import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const config = loadConfig(process.env, {
      requireAuth: true,
      service: "web",
    });
    const pepper = config.secrets.authTokenPepper;
    if (pepper === undefined)
      throw new Error("authentication configuration unavailable");
    const body = await jsonObject(request);
    if (typeof body.name !== "string" || !Array.isArray(body.scopes))
      throw new TypeError("API key name and scopes are required");
    const scopes = body.scopes.filter(
      (scope): scope is string => typeof scope === "string",
    );
    const issued = await withCurrentTenant("tenant:manage", (sql, session) =>
      createApiKey(sql, session.userId, pepper, body.name as string, scopes),
    );
    return NextResponse.json(issued, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
