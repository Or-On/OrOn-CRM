import { NextResponse } from "next/server";
import { ControlApiClient } from "@or-on/api-client";
import { loadConfig } from "@or-on/config";
import {
  issueControlApiGrant,
  jsonObject,
  withFreshCurrentTenant,
} from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function privateResponse(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const body = await jsonObject(request);
    if (
      !uuid.test(id) ||
      typeof body.versionId !== "string" ||
      !uuid.test(body.versionId) ||
      body.confirmed !== true ||
      typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.length > 1000 ||
      /[<>[\]{}\p{C}]/u.test(body.text) ||
      Object.keys(body).some(
        (key) => !["versionId", "text", "confirmed"].includes(key),
      )
    ) {
      return privateResponse(
        NextResponse.json(
          { error: "Invalid provider evaluation request" },
          { status: 400 },
        ),
      );
    }
    const assertion = await withFreshCurrentTenant(
      "flows:manage",
      (_sql, session) => issueControlApiGrant(session, "orchestration:write"),
    );
    const config = loadConfig(process.env, { service: "web" });
    const client = new ControlApiClient(config.controlApiUrl, (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${assertion}`);
      return fetch(input, {
        ...init,
        headers,
        cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(13000)]),
      });
    });
    const result = await client.evaluateAgentProvider({
      agent_id: id,
      version_id: body.versionId,
      text: body.text.trim(),
      confirmed: true,
    });
    if (!result.ok) {
      const status = [401, 403, 404, 429, 503, 504].includes(result.status)
        ? result.status
        : 503;
      return privateResponse(
        NextResponse.json(
          { error: "Provider evaluation unavailable" },
          { status },
        ),
      );
    }
    return privateResponse(NextResponse.json({ evaluation: result.data }));
  } catch (error) {
    return privateResponse(crmErrorResponse(error));
  }
}
