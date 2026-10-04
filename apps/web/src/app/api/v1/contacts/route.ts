import { NextResponse } from "next/server";

import {
  InvalidApiKeyError,
  createContact,
  listContacts,
  withApiKeyTenant,
} from "@or-on/crm";
import { loadConfig } from "@or-on/config";
import { jsonObject } from "../../../../features/auth";

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
    throw new InvalidApiKeyError("invalid API key");
  return authorization.slice(7);
}

class InvalidRequestError extends Error {}

function apiError(error: unknown): NextResponse {
  if (error instanceof InvalidApiKeyError)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (error instanceof SyntaxError)
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  if (error instanceof InvalidRequestError)
    return NextResponse.json(
      {
        error:
          error.message === "request body is too large"
            ? "Payload too large"
            : "Invalid request",
      },
      { status: error.message === "request body is too large" ? 413 : 400 },
    );
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
    const contact = await withApiKeyTenant(
      config.databaseUrl,
      config.pepper,
      bearer(request),
      "crm:write",
      async (sql) => {
        // Resolve the credential and its stored tenant before consuming any
        // caller bytes. Scope and tenant never come from the request body.
        const body = await jsonObject(request, { maximumBytes: 16_384 }).catch(
          (error: unknown) => {
            if (error instanceof TypeError)
              throw new InvalidRequestError(error.message);
            throw error;
          },
        );
        if (typeof body.name !== "string" || body.name.trim() === "")
          throw new InvalidRequestError("contact name is required");
        const name = body.name.trim();
        return createContact(sql, null, { name });
      },
    );
    return NextResponse.json({ contact }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
