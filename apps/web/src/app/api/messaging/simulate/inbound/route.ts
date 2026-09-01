import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { ingestSimulatedInbound } from "@or-on/crm";
import { loadConfig } from "@or-on/config";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function POST(request: Request) {
  try {
    const config = loadConfig(process.env, { service: "web" });
    if (config.environment !== "development")
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (
      typeof body.from !== "string" ||
      typeof body.profileName !== "string" ||
      typeof body.text !== "string"
    ) {
      throw new TypeError("from, profileName, and text are required");
    }
    const providerEventId =
      typeof body.providerEventId === "string"
        ? body.providerEventId
        : `sim_evt_${randomUUID()}`;
    const providerMessageId =
      typeof body.providerMessageId === "string"
        ? body.providerMessageId
        : `sim_msg_${randomUUID()}`;
    const result = await withCurrentTenant(
      "messaging:operate",
      (sql, session) =>
        ingestSimulatedInbound(sql, session.userId, {
          from: body.from as string,
          profileName: body.profileName as string,
          text: body.text as string,
          providerEventId,
          providerMessageId,
        }),
    );
    return NextResponse.json(result, { status: result.inserted ? 201 : 200 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
