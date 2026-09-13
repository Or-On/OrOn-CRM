import { NextResponse } from "next/server";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";
import {
  oauthProvider,
  readOAuthCredential,
  saveOAuthCredential,
} from "../../../../../features/email";

export async function GET() {
  try {
    const configured = await withCurrentTenant(
      "tenant:manage",
      async (sql) => ({
        google: (await readOAuthCredential(sql, "google")) !== undefined,
        microsoft: (await readOAuthCredential(sql, "microsoft")) !== undefined,
      }),
    );
    return NextResponse.json(configured);
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const provider = oauthProvider(
      typeof body.provider === "string" ? body.provider : "",
    );
    const clientId =
      typeof body.clientId === "string" ? body.clientId.trim() : "";
    const clientSecret =
      typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
    const directoryTenant =
      typeof body.directoryTenant === "string"
        ? body.directoryTenant.trim()
        : undefined;
    if (
      !clientId ||
      !clientSecret ||
      clientId.length > 500 ||
      clientSecret.length > 2000
    )
      throw new TypeError("Client ID and client secret are required");
    await withCurrentTenant("tenant:manage", (sql) =>
      saveOAuthCredential(sql, provider, {
        clientId,
        clientSecret,
        ...(directoryTenant ? { directoryTenant } : {}),
      }),
    );
    return NextResponse.json({ configured: true, provider });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
