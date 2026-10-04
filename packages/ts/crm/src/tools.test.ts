import { describe, expect, it, vi } from "vitest";

import { crmToolDescriptors, executeCrmTool } from "./tools.js";

describe("CRM tool contract", () => {
  it.each(["unknown_tool", "", "CRM_ADD_CONTACT_NOTE"])(
    "rejects unknown runtime tool %j before database access even with confirmation",
    async (name) => {
      const sql = vi.fn();
      await expect(
        executeCrmTool(sql as never, "actor", name, {
          confirm: true,
          contactId: "contact",
          body: "note",
        }),
      ).rejects.toThrow("unknown CRM tool");
      expect(sql).not.toHaveBeenCalled();
    },
  );

  it("still dispatches the named confirmed note write", async () => {
    const sql = vi.fn().mockResolvedValue([
      {
        id: "note",
        author_user_id: "actor",
        body: "allowed note",
        created_at: new Date("2026-10-04T00:00:00Z"),
      },
    ]);
    await expect(
      executeCrmTool(sql as never, "actor", "crm_add_contact_note", {
        confirm: true,
        contactId: "contact",
        body: "allowed note",
      }),
    ).resolves.toMatchObject({ id: "note", body: "allowed note" });
    expect(sql).toHaveBeenCalledOnce();
  });

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
