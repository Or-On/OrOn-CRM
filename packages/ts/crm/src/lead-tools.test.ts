import { describe, expect, it } from "vitest";

import { parseLeadFieldSchema } from "./lead-schema.js";
import {
  isLeadToolName,
  leadOperationKey,
  leadToolDescriptors,
  leadToolNames,
} from "./lead-tools.js";

const schema = parseLeadFieldSchema([
  {
    key: "preferred_name",
    label: "Preferred name",
    type: "text",
    required: true,
  },
  { key: "budget", label: "Budget", type: "currency", required: false },
]);

describe("lead tool descriptors", () => {
  it("offers nothing to an agent without lead capabilities", () => {
    expect(leadToolDescriptors([], schema)).toEqual([]);
  });

  it("offers only reading to a read-only agent", () => {
    expect(
      leadToolDescriptors(["lead.read"], schema).map(
        (descriptor) => descriptor.name,
      ),
    ).toEqual(["lead_read_state"]);
  });

  it("implies reading for a writing agent without granting finalization", () => {
    expect(
      leadToolDescriptors(["lead.write"], schema).map(
        (descriptor) => descriptor.name,
      ),
    ).toEqual(["lead_read_state", "lead_save_fields"]);
  });

  it("offers the full set only when every capability was published", () => {
    expect(
      leadToolDescriptors(
        ["lead.read", "lead.write", "lead.finalize", "lead.follow_up"],
        schema,
      ).map((descriptor) => descriptor.name),
    ).toEqual([...leadToolNames]);
  });

  it("enumerates exactly the reviewed schema's fields, closed to others", () => {
    const save = leadToolDescriptors(["lead.write"], schema).find(
      (descriptor) => descriptor.name === "lead_save_fields",
    );
    const parameters = save?.parameters as unknown as {
      properties: {
        observations: {
          items: {
            additionalProperties: boolean;
            properties: { key: { enum: string[] } };
          };
        };
      };
    };
    expect(
      parameters.properties.observations.items.properties.key.enum,
    ).toEqual(["preferred_name", "budget"]);
    expect(parameters.properties.observations.items.additionalProperties).toBe(
      false,
    );
  });

  it("never exposes a tenant, contact or lead argument to the model", () => {
    const serialized = JSON.stringify(
      leadToolDescriptors(
        ["lead.read", "lead.write", "lead.finalize", "lead.follow_up"],
        schema,
      ).map((descriptor) => descriptor.parameters),
    );
    for (const forbidden of ["tenant", "contactId", "leadId", "agentId"])
      expect(serialized).not.toContain(forbidden);
  });

  it("recognises only the four supported tool names", () => {
    expect(isLeadToolName("lead_save_fields")).toBe(true);
    expect(isLeadToolName("lead_delete_everything")).toBe(false);
    expect(isLeadToolName("crm_add_contact_note")).toBe(false);
  });
});

describe("lead operation identity", () => {
  const context = { interactionKey: "conversation-1", turnKey: "message-42" };

  it("is stable for the same interaction, turn and arguments", () => {
    expect(leadOperationKey(context, "lead_save_fields", '{"a":1}')).toBe(
      leadOperationKey(context, "lead_save_fields", '{"a":1}'),
    );
  });

  it("changes when the turn, the tool or the arguments change", () => {
    const base = leadOperationKey(context, "lead_save_fields", '{"a":1}');
    expect(
      leadOperationKey(
        { ...context, turnKey: "message-43" },
        "lead_save_fields",
        '{"a":1}',
      ),
    ).not.toBe(base);
    expect(
      leadOperationKey(context, "lead_request_follow_up", '{"a":1}'),
    ).not.toBe(base);
    expect(leadOperationKey(context, "lead_save_fields", '{"a":2}')).not.toBe(
      base,
    );
  });

  it("does not collide across interactions that share a turn number", () => {
    expect(
      leadOperationKey(
        { interactionKey: "conversation-2", turnKey: "message-42" },
        "lead_save_fields",
        "{}",
      ),
    ).not.toBe(leadOperationKey(context, "lead_save_fields", "{}"));
  });

  it("stays inside the stored operation key length", () => {
    const key = leadOperationKey(context, "lead_finalize_collection", "{}");
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(200);
  });
});
