import { randomUUID } from "node:crypto";
import { simulationRefusal } from "../../../../../../features/simulation-policy";

import { NextResponse } from "next/server";

import {
  listMessagePage,
  parseMessageCursor,
  queueWhatsAppOutbound,
} from "@or-on/crm";
import { loadConfig } from "@or-on/config";

import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

export async function GET(
  request: Request,
  context: RouteContext<"/api/messaging/conversations/[id]/messages">,
) {
  try {
    const { id } = await context.params;
    const parameters = new URL(request.url).searchParams;
    const before = parseMessageCursor(
      parameters.get("before"),
      parameters.get("beforeId"),
    );
    const page = await withCurrentTenant("crm:read", (sql) =>
      listMessagePage(sql, id, before === undefined ? {} : { before }),
    );
    return NextResponse.json(page);
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/messaging/conversations/[id]/messages">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const body = await jsonObject(request);
    const provider = body.provider === "meta" ? "meta" : "simulator";
    if (provider === "simulator") {
      const refusal = simulationRefusal();
      if (refusal) return refusal;
    }
    const kind = body.kind === "template" ? "template" : "text";
    const suppliedIdempotencyKey = request.headers
      .get("idempotency-key")
      ?.trim();
    const idempotencyKey =
      suppliedIdempotencyKey === undefined || suppliedIdempotencyKey === ""
        ? randomUUID()
        : suppliedIdempotencyKey;
    const config = loadConfig(process.env, {
      requireWhatsApp: true,
      service: "web",
    });
    const result = await withCurrentTenant(
      "messaging:operate",
      (sql, session) => {
        const common = {
          conversationId: id,
          senderUserId: session.userId,
          provider,
          explicitlyConfirmed: body.confirmReal === true,
          realProviderEnabled: config.enableRealWhatsApp,
          idempotencyKey,
        } as const;
        return queueWhatsAppOutbound(
          sql,
          kind === "template"
            ? {
                ...common,
                kind,
                templateName:
                  typeof body.templateName === "string"
                    ? body.templateName
                    : "",
                language:
                  typeof body.language === "string" ? body.language : "",
                parameters: Array.isArray(body.parameters)
                  ? body.parameters.filter(
                      (value): value is string => typeof value === "string",
                    )
                  : [],
              }
            : {
                ...common,
                kind,
                text: typeof body.text === "string" ? body.text : "",
              },
          provider === "meta" &&
            config.whatsApp.graphApiVersion !== undefined &&
            config.whatsApp.phoneNumberId !== undefined &&
            config.whatsApp.wabaId !== undefined
            ? {
                graphApiVersion: config.whatsApp.graphApiVersion,
                phoneNumberId: config.whatsApp.phoneNumberId,
                wabaId: config.whatsApp.wabaId,
              }
            : undefined,
        );
      },
    );
    return NextResponse.json(result, { status: result.queued ? 202 : 200 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
