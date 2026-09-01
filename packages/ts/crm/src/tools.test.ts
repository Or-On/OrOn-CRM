import { describe, expect, it } from "vitest";

import { crmToolDescriptors, executeCrmTool } from "./tools.js";

describe("CRM tool contract", () => {
  it("labels every mutating tool", () => {
    expect(
      crmToolDescriptors
        .filter((tool) => tool.mutating)
        .map((tool) => tool.name),
    ).toEqual(["crm_add_contact_note"]);
  });

  it("rejects a write before any database call without explicit confirmation", async () => {
    await expect(
      executeCrmTool(
        (() => {
          throw new Error("database must not be called");
        }) as never,
        "20000000-0000-4000-8000-000000000001",
        "crm_add_contact_note",
        { contactId: "contact", body: "note" },
      ),
    ).rejects.toThrow("confirm=true");
  });
});
