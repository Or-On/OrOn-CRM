import { NextResponse } from "next/server";

import {
  listTickets,
  type TicketHandlingMode,
  type TicketPriority,
  type TicketResolution,
  type TicketSourceChannel,
  type TicketStage,
  type TicketStatus,
} from "@or-on/crm";

import { withCurrentTenant } from "../../../features/auth";
import { crmErrorResponse } from "../../../features/crm-route";

const stages = new Set<TicketStage>([
  "new",
  "ai_handling",
  "callback_pending",
  "in_call",
  "awaiting_customer",
  "awaiting_human",
  "closed",
]);
const priorities = new Set<TicketPriority>(["low", "normal", "high", "urgent"]);
const channels = new Set<TicketSourceChannel>(["whatsapp", "voice", "manual"]);
const handlingModes = new Set<TicketHandlingMode>([
  "ai_whatsapp",
  "ai_voice",
  "human",
  "paused",
]);
const resolutions = new Set<TicketResolution>([
  "unknown",
  "unresolved",
  "proposed_fix_awaiting_confirmation",
  "resolved",
]);

/** Open/Closed/All are the primary filter; stage is the detail beneath it. */
function listStatus(value: string | null): TicketStatus | "all" | undefined {
  if (value === null) return undefined;
  if (value !== "open" && value !== "closed" && value !== "all")
    throw new TypeError("ticket status must be open, closed, or all");
  return value;
}

/** One rejection path for every enumerated filter, so none is spelled loosely. */
function member<T extends string>(
  allowed: ReadonlySet<T>,
  value: string | null,
  name: string,
): T | undefined {
  if (value === null) return undefined;
  if (!allowed.has(value as T)) throw new TypeError(`invalid ticket ${name}`);
  return value as T;
}

function listLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d{1,3}$/u.test(value))
    throw new TypeError("invalid ticket page size");
  const parsed = Number(value);
  if (parsed < 1 || parsed > 100)
    throw new TypeError("ticket page size must be 1 to 100");
  return parsed;
}

function cursorInstant(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!Number.isFinite(Date.parse(value)))
    throw new TypeError("invalid ticket cursor");
  return value;
}

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const status = listStatus(parameters.get("status"));
    const stage = member(stages, parameters.get("stage"), "stage");
    const priority = member(priorities, parameters.get("priority"), "priority");
    const sourceChannel = member(
      channels,
      parameters.get("channel"),
      "channel",
    );
    const handlingMode = member(
      handlingModes,
      parameters.get("handling"),
      "handling mode",
    );
    const resolution = member(
      resolutions,
      parameters.get("resolution"),
      "resolution",
    );
    const limit = listLimit(parameters.get("limit"));
    const activeSince = cursorInstant(parameters.get("activeSince"));
    const beforeActivityAt = cursorInstant(parameters.get("beforeActivityAt"));
    const beforeId = parameters.get("beforeId");
    const query = parameters.get("q");
    const owner = parameters.get("ownerUserId");
    // Paginated server-side on purpose: a tenant's whole ticket history must
    // never be shipped to a browser to be filtered there.
    const page = await withCurrentTenant("crm:read", (sql) =>
      listTickets(sql, {
        ...(status === undefined ? {} : { status }),
        ...(stage === undefined ? {} : { stage }),
        ...(priority === undefined ? {} : { priority }),
        ...(sourceChannel === undefined ? {} : { sourceChannel }),
        ...(handlingMode === undefined ? {} : { handlingMode }),
        ...(resolution === undefined ? {} : { resolution }),
        ...(limit === undefined ? {} : { limit }),
        ...(query === null ? {} : { query }),
        ...(owner === null ? {} : { ownerUserId: owner }),
        ...(activeSince === undefined ? {} : { activeSince }),
        ...(beforeActivityAt === undefined ? {} : { beforeActivityAt }),
        ...(beforeId === null ? {} : { beforeId }),
      }),
    );
    return NextResponse.json(page);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
