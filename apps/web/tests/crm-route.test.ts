import { describe, expect, it } from "vitest";

import { crmErrorResponse } from "../src/features/crm-route";

describe("CRM PostgreSQL error responses", () => {
  it("returns a useful conflict when active configuration needs a module", async () => {
    const error = new Error("feature is required by active process Intake");
    Object.assign(error, { code: "TF409" });

    const response = crmErrorResponse(error);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "feature is required by active process Intake",
    });
  });

  it.each([
    ["42501", 403, "Forbidden"],
    ["P0002", 404, "The requested record was not found"],
    ["22023", 400, "The request violates a platform constraint"],
    ["23514", 400, "The request violates a platform constraint"],
    ["23505", 409, "A matching record already exists"],
  ])(
    "maps SQLSTATE %s without exposing database details",
    async (code, status, message) => {
      const response = crmErrorResponse({
        code,
        message: "sensitive database diagnostic",
        detail: "sensitive row content",
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: message });
    },
  );

  it.each([
    ["FS428", 428, "TECHNICIAN_IDENTIFICATION_REQUIRED"],
    ["FS401", 403, "TECHNICIAN_IDENTITY_MISMATCH"],
    ["FS409", 409, "TECHNICIAN_SESSION_ALREADY_BOUND"],
  ])(
    "explains shared technician session state %s with a stable code",
    async (sqlstate, status, code) => {
      const response = crmErrorResponse({
        code: sqlstate,
        message: "identify the technician using this session",
        detail: "sensitive row content",
      });

      expect(response.status).toBe(status);
      const body = (await response.json()) as { error: string; code: string };
      expect(body.code).toBe(code);
      expect(body.error).not.toContain("sensitive");
    },
  );
});
