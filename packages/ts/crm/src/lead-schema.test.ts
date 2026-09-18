import { describe, expect, it } from "vitest";

import {
  assertCapability,
  capabilityChannelConflicts,
  effectiveCapabilities,
  parseAgentCapabilities,
  requireAgentCapabilities,
} from "./agent-capabilities.js";
import {
  leadCompleteness,
  normalizeLeadField,
  parseLeadFieldSchema,
  type LeadFieldSchema,
} from "./lead-schema.js";

const schema = parseLeadFieldSchema([
  {
    key: "preferred_name",
    label: "Preferred name",
    type: "text",
    required: true,
  },
  { key: "company", label: "Company", type: "text", required: true },
  {
    key: "service",
    label: "Requested service",
    type: "choice",
    required: true,
    choices: ["CRM", "Telephony", "Automation"],
  },
  { key: "seats", label: "Users", type: "number", required: false, minimum: 1 },
  { key: "budget", label: "Budget", type: "currency", required: false },
  { key: "start_on", label: "Start", type: "date", required: false },
  { key: "callback", label: "Callback number", type: "phone", required: false },
  { key: "email", label: "Email", type: "email", required: false },
  { key: "newsletter", label: "Newsletter", type: "boolean", required: false },
]);

function known(key: string, value: string, extra: Record<string, string> = {}) {
  return normalizeLeadField(
    schema,
    { key, state: "known" as const, value, ...extra },
    { phoneRegion: "IL" },
  );
}

describe("lead field schema", () => {
  it("rejects a field that the reviewed schema does not contain", () => {
    expect(() => known("national_id", "123456789")).toThrow(
      /not part of this lead's reviewed field schema/u,
    );
  });

  it("keeps the customer's words alongside the normalized value", () => {
    const field = known("callback", "052-123 4567");
    expect(field.rawValue).toBe("052-123 4567");
    expect(field.normalizedValue).toBe("+972521234567");
  });

  it("refuses to guess a country code without an approved region", () => {
    expect(() =>
      normalizeLeadField(schema, {
        key: "callback",
        state: "known",
        value: "0521234567",
      }),
    ).toThrow(/international/u);
  });

  it("requires a currency code rather than assuming one", () => {
    expect(() => known("budget", "1200")).toThrow(/ISO 4217/u);
    expect(known("budget", "1,200.50", { currency: "ils" })).toMatchObject({
      normalizedValue: "1200.50",
      currency: "ILS",
    });
  });

  it("accepts a comma decimal separator", () => {
    expect(known("seats", "12").normalizedValue).toBe("12");
    expect(
      known("budget", "1200,50", { currency: "USD" }).normalizedValue,
    ).toBe("1200.50");
  });

  it("never infers a date from vague speech", () => {
    expect(() => known("start_on", "next month")).toThrow(
      /exact calendar date/u,
    );
    expect(() => known("start_on", "2026-02-30")).toThrow(
      /not a real calendar date/u,
    );
    expect(known("start_on", "2026-03-01").normalizedValue).toBe("2026-03-01");
  });

  it("matches a choice case-insensitively and rejects an invented one", () => {
    expect(known("service", "crm").normalizedValue).toBe("CRM");
    expect(() => known("service", "Hosting")).toThrow(/must be one of/u);
  });

  it("accepts Hebrew yes and no for a boolean", () => {
    expect(known("newsletter", "כן").normalizedValue).toBe("true");
    expect(known("newsletter", "לא").normalizedValue).toBe("false");
  });

  it("enforces declared bounds", () => {
    expect(() => known("seats", "0")).toThrow(/at least 1/u);
  });

  it("treats a refusal as an answer without a value", () => {
    const declined = normalizeLeadField(schema, {
      key: "budget",
      state: "declined",
    });
    expect(declined).toMatchObject({
      state: "declined",
      rawValue: null,
      normalizedValue: null,
    });
    expect(() =>
      normalizeLeadField(schema, {
        key: "budget",
        state: "declined",
        value: "1200",
      }),
    ).toThrow(/only a known value may carry content/u);
  });

  it("refuses a blank known value instead of storing an empty fact", () => {
    expect(() => known("company", "   ")).toThrow(/cannot be blank/u);
  });

  it("rejects a schema that exceeds the reviewed size or repeats a key", () => {
    expect(() => parseLeadFieldSchema([])).toThrow(/at least one field/u);
    expect(() =>
      parseLeadFieldSchema([
        { key: "a", label: "A", type: "text", required: true },
        { key: "a", label: "A again", type: "text", required: false },
      ]),
    ).toThrow(/unique/u);
    expect(() =>
      parseLeadFieldSchema([
        { key: "Bad Key", label: "Bad", type: "text", required: true },
      ]),
    ).toThrow(/invalid field key/u);
  });

  it("does not hard-code the example agent's fields", () => {
    const survey: LeadFieldSchema = parseLeadFieldSchema([
      {
        key: "satisfaction",
        label: "Satisfaction",
        type: "choice",
        required: true,
        choices: ["low", "medium", "high"],
      },
      { key: "device_count", label: "Devices", type: "number", required: true },
    ]);
    expect(survey.fields.map((field) => field.key)).toEqual([
      "satisfaction",
      "device_count",
    ]);
    expect(
      normalizeLeadField(survey, {
        key: "satisfaction",
        state: "known",
        value: "HIGH",
      }).normalizedValue,
    ).toBe("high");
  });
});

describe("lead completeness", () => {
  it("counts a declined required field as answered, not missing", () => {
    expect(
      leadCompleteness(schema, [
        { key: "preferred_name", state: "known" },
        { key: "company", state: "declined" },
      ]),
    ).toMatchObject({
      missing: ["service"],
      declined: ["company"],
      complete: false,
    });
  });

  it("ignores optional fields when reporting completeness", () => {
    expect(
      leadCompleteness(schema, [
        { key: "preferred_name", state: "known" },
        { key: "company", state: "known" },
        { key: "service", state: "known" },
      ]).complete,
    ).toBe(true);
  });

  it("treats an unknown state as still missing", () => {
    expect(
      leadCompleteness(schema, [{ key: "preferred_name", state: "unknown" }])
        .missing,
    ).toContain("preferred_name");
  });
});

describe("agent capabilities", () => {
  it("never grants a capability that was not selected", () => {
    expect(() => assertCapability([], "lead.write")).toThrow(
      /not authorized for lead.write/u,
    );
    expect(() => assertCapability(["lead.read"], "lead.write")).toThrow(
      /not authorized/u,
    );
  });

  it("keeps a historical permission row readable by dropping unknown entries", () => {
    expect(parseAgentCapabilities(["lead.read", "legacy.support"])).toEqual([
      "lead.read",
    ]);
    expect(parseAgentCapabilities("lead.read")).toEqual([]);
  });

  it("rejects an unknown capability at the authoring boundary", () => {
    expect(() =>
      requireAgentCapabilities(["lead.write", "shell.exec"]),
    ).toThrow(/unsupported agent capability/u);
  });

  it("implies read for any writing capability", () => {
    expect(effectiveCapabilities(["lead.finalize"])).toEqual([
      "lead.finalize",
      "lead.read",
    ]);
    expect(effectiveCapabilities([])).toEqual([]);
  });

  it("reports no channel conflict for lead work on supported channels", () => {
    expect(
      capabilityChannelConflicts(["lead.write"], ["voice", "whatsapp"]),
    ).toEqual([]);
  });
});
