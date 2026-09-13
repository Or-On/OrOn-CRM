import { describe, expect, it } from "vitest";

import { crmErrorResponse } from "../src/features/crm-route";

describe("CRM PostgreSQL error responses", () => {
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
});
