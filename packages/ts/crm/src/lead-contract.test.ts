import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { leadCaptureContract } from "./lead-capture-contract.generated.js";
import {
  LeadFieldValidationError,
  leadCompleteness,
  normalizeLeadField,
  parseLeadFieldSchema,
  type LeadFieldObservationInput,
  type LeadFieldState,
} from "./lead-schema.js";
import { leadToolDescriptors } from "./lead-tools.js";

// The Python voice runtime runs these same fixtures from its own mirror
// (packages/py/oron-agent/tests/test_lead_capture_contract.py). A rule that
// changes in only one language fails one of the two suites.
const canonical = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../db/contracts/lead-capture.v1.json", import.meta.url),
    ),
    "utf8",
  ),
) as typeof leadCaptureContract;

const parity = leadCaptureContract.parity;
const schema = parseLeadFieldSchema(parity.schema);

describe("canonical lead capture contract", () => {
  it("is mirrored into TypeScript unchanged", () => {
    expect(leadCaptureContract).toEqual(canonical);
  });

  it("declares every error code the normalizer can raise", () => {
    const declared = new Set<string>(leadCaptureContract.errorCodes);
    for (const entry of parity.normalization)
      if ("error" in entry)
        expect(declared.has(entry.error), entry.name).toBe(true);
  });

  for (const entry of parity.normalization) {
    it(`normalizes: ${entry.name}`, () => {
      const options = "options" in entry ? entry.options : {};
      const run = () =>
        normalizeLeadField(
          schema,
          entry.observation as unknown as LeadFieldObservationInput,
          options,
        );
      if ("error" in entry) {
        let caught: unknown;
        try {
          run();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(LeadFieldValidationError);
        expect((caught as LeadFieldValidationError).code).toBe(entry.error);
        return;
      }
      const result = run();
      for (const [key, value] of Object.entries(entry.expect))
        expect(result[key as keyof typeof result], key).toEqual(value);
    });
  }

  it("advertises the same tool surface it did before moving into the contract", () => {
    const descriptors = leadToolDescriptors(
      ["lead.write", "lead.finalize", "lead.follow_up"],
      schema,
    );
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      "lead_read_state",
      "lead_save_fields",
      "lead_finalize_collection",
      "lead_request_follow_up",
    ]);
    const byName = new Map(
      descriptors.map((entry) => [entry.name, entry.parameters]),
    );
    expect(byName.get("lead_read_state")).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
    expect(byName.get("lead_finalize_collection")).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: {
        summary: {
          type: "string",
          maxLength: 4000,
          description: "What the customer asked for, in their own terms.",
        },
        nextAction: { type: "string", maxLength: 1000 },
      },
    });
    expect(byName.get("lead_request_follow_up")).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["note"],
      properties: {
        note: { type: "string", maxLength: 1000 },
        dueAt: {
          type: "string",
          description:
            "ISO timestamp, only when the customer named a specific time.",
        },
      },
    });
    expect(byName.get("lead_save_fields")).toMatchObject({
      required: ["observations"],
      properties: {
        observations: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            required: ["key", "state"],
            properties: {
              key: { enum: schema.fields.map((field) => field.key) },
            },
          },
        },
      },
    });
    // No capability, no tool: a prompt that promises saving cannot conjure it.
    expect(leadToolDescriptors([], schema)).toEqual([]);
  });

  for (const entry of parity.completeness) {
    it(`completeness: ${entry.name}`, () => {
      expect(
        leadCompleteness(
          schema,
          entry.current as readonly { key: string; state: LeadFieldState }[],
        ),
      ).toEqual(entry.expect);
    });
  }

  for (const entry of parity.schemas) {
    it(`schema: ${entry.name}`, () => {
      if ("error" in entry) {
        expect(() => parseLeadFieldSchema(entry.definition)).toThrow(TypeError);
        return;
      }
      expect(
        parseLeadFieldSchema(entry.definition).fields.map((field) => field.key),
      ).toEqual(entry.expectKeys);
    });
  }
});
