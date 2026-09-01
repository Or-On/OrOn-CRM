import { NextResponse } from "next/server";

import { createContact, listContacts, withApiKeyTenant } from "@or-on/crm";
import { loadConfig } from "@or-on/config";

function apiConfiguration() {
  const config = loadConfig(process.env, {
    requireDatabase: true,
    service: "web",
  });
  if (
    config.databaseUrl === undefined ||
    config.secrets.authTokenPepper === undefined
  )
    throw new Error("public API configuration unavailable");
  return {
    databaseUrl: config.databaseUrl,
    pepper: config.secrets.authTokenPepper,
  };
}

function bearer(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer "))
    throw new TypeError("invalid API key");
  return authorization.slice(7);
}

function apiError(error: unknown): NextResponse {
  if (error instanceof TypeError)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  console.error("Public CRM API failed", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
}

export async function GET(request: Request) {
  try {
    const config = apiConfiguration();
    const query = new URL(request.url).searchParams.get("q") ?? undefined;
    const contacts = await withApiKeyTenant(
      config.databaseUrl,
      config.pepper,
      bearer(request),
      "crm:read",
      (sql) => listContacts(sql, query === undefined ? {} : { query }),
    );
    return NextResponse.json({ contacts });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const config = apiConfiguration();
    const body = (await request.json()) as unknown;
    if (
      body === null ||
      typeof body !== "object" ||
      !("name" in body) ||
      typeof body.name !== "string"
    )
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    const name = body.name;
    const contact = await withApiKeyTenant(
      config.databaseUrl,
      config.pepper,
      bearer(request),
      "crm:write",
      (sql) => createContact(sql, null, { name }),
    );
    return NextResponse.json({ contact }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
