import { describe, expect, it } from "vitest";
import { ForbiddenError as AuthForbiddenError } from "@or-on/auth";
import { ForbiddenError } from "../src/features/auth";
import { crmErrorResponse } from "../src/features/crm-route";
describe("canonical auth error response", () => {
  it("recognizes real service CSRF denial as forbidden", () => {
    expect(ForbiddenError).toBe(AuthForbiddenError);
    const response = crmErrorResponse(new AuthForbiddenError());
    expect(response.status).toBe(403);
  });
});
