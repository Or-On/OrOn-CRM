import { describe, expect, it } from "vitest";
import { incompleteRequest } from "./incomplete-service-requests.js";

const start = new Date("2026-10-08T00:00:00Z");
const base = {
  id: "fictional",
  customer_name: "בדיקה",
  recipient: "+972501234567",
  followup_status: "queued",
  followup_error_safe: null,
  send_status: null,
  send_error: null,
  created_at: start,
  updated_at: start,
  requested_at: start,
  first_opened_at: null,
  expires_at: new Date("2026-10-09T00:00:00Z"),
  consent: "granted",
  opted_out: false,
  attempt: 1,
  now: new Date("2026-10-08T00:15:00Z"),
  provider_message_id: null,
  can_manage: true,
};

describe("incomplete requests preserve delivery uncertainty and safe actions", () => {
  it("uses the exact durable 15-minute threshold without a new notification per refresh", () => {
    expect(
      incompleteRequest({ ...base, now: new Date(start.valueOf() + 899999) })
        .needsAttention,
    ).toBe(false);
    expect(incompleteRequest(base).needsAttention).toBe(true);
    expect(
      incompleteRequest({
        ...base,
        followup_status: "admitted",
        send_status: "sent",
      }).needsAttention,
    ).toBe(false);
  });
  it("distinguishes sent from observed form opening", () => {
    expect(incompleteRequest({ ...base, send_status: "sent" })).toMatchObject({
      stage: "awaiting_submission",
      openedAt: null,
    });
    expect(
      incompleteRequest({
        ...base,
        send_status: "read",
        first_opened_at: start,
      }),
    ).toMatchObject({ stage: "opened", openedAt: start.toISOString() });
  });
  it("allows recovery only after a definite failure, never an ambiguous provider outcome", () => {
    const failed = {
      ...base,
      send_status: "failed",
      followup_status: "failed",
    };
    expect(incompleteRequest(failed).actions).toEqual(["retry", "close"]);
    for (const change of [
      { send_status: "sending" },
      { send_error: "delivery_outcome_unknown" },
      { provider_message_id: "accepted" },
      { opted_out: true },
      { recipient: null },
    ])
      expect(incompleteRequest({ ...failed, ...change }).actions).toEqual([
        "close",
      ]);
    expect(incompleteRequest({ ...failed, can_manage: false }).actions).toEqual(
      [],
    );
  });
  it("offers a new lifecycle after expiry but cannot repeat a request still in flight", () => {
    const expired = { ...base, expires_at: start, send_status: "sent" };
    expect(incompleteRequest(expired).actions).toEqual([
      "new_request",
      "close",
    ]);
    expect(
      incompleteRequest({ ...expired, send_status: "queued" }).actions,
    ).toEqual(["close"]);
  });
});
