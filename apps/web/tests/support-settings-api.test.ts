import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateTenantSupportText,
  tenantSupportTextLimits,
} from "@or-on/crm/support-profile-text";
import type { TenantSettings } from "@or-on/crm";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  rename: vi.fn(),
  permission: vi.fn(),
  guard: vi.fn(),
}));
vi.mock("@or-on/crm", () => ({
  updateTenantSettings: state.update,
  updateCurrentTenantName: state.rename,
  tenantSupportTextLimits,
}));
vi.mock("../src/features/auth", async () => ({
  jsonObject: (await import("../src/features/auth/request")).jsonObject,
  requestId: () => "settings-regression",
  withCurrentTenant: (
    permission: string,
    action: (sql: unknown) => unknown,
  ) => {
    state.permission(permission);
    return action({});
  },
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: state.guard,
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "Refused" },
      { status: 400 },
    ),
}));

import { PATCH } from "../src/app/api/settings/route";

function request(productsAndServices: readonly string[]) {
  return new Request("https://example.invalid/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenantName: "Fictional business",
      displayName: "Fictional business",
      defaultCurrency: "ILS",
      locale: "he",
      timezone: "Asia/Jerusalem",
      supportProfile: {
        schemaVersion: "1.0",
        businessDescription: "חברה שמסייעת לעסקים בשירות ובתמיכה.",
        productsAndServices,
      },
    }),
  });
}

describe("AI support settings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.guard.mockResolvedValue(undefined);
    state.rename.mockResolvedValue("Fictional business");
    state.update.mockImplementation((_sql: unknown, input: TenantSettings) => {
      if (input.supportProfile) validateTenantSupportText(input.supportProfile);
      return Promise.resolve(input);
    });
  });

  it("accepts long natural service paragraphs behind existing mutation and tenant-management guards", async () => {
    const service =
      "Support service with implementation guidance and ongoing assistance. ".repeat(
        10,
      );
    const response = await PATCH(request([service]));
    expect(response.status).toBe(200);
    expect(state.guard).toHaveBeenCalledOnce();
    expect(state.permission).toHaveBeenCalledWith("tenant:manage");
    expect(await response.json()).toMatchObject({
      settings: { supportProfile: { productsAndServices: [service] } },
    });
    expect(state.rename).toHaveBeenCalledOnce();
  });

  it("returns an actionable limit error before renaming or completing settings persistence", async () => {
    const response = await PATCH(request(["x".repeat(4_001)]));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "tenant products and services exceed text limits",
    });
    expect(state.rename).not.toHaveBeenCalled();
  });

  it("accepts a bounded Hebrew profile larger than the former 16 KiB request limit", async () => {
    const services = ["א".repeat(4_000), "ב".repeat(4_000), "ג".repeat(4_000)];
    const response = await PATCH(request(services));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      settings: { supportProfile: { productsAndServices: services } },
    });
  });
});
