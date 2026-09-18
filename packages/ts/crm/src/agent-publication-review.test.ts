import { describe, expect, it } from "vitest";

import { reviewAgentPublication } from "./agent-publication-review.js";
import { parseLeadFieldSchema } from "./lead-schema.js";

// The coordinator prompt the lead agent is evaluated with (agent B).
const coordinatorPrompt = `You are the Hebrew-speaking lead coordinator for the configured business. Understand the customer's interest in our business software and collect their preferred name, company, requested service, approximate number of users, budget and currency when they choose to share them, desired start timeframe, and preferred follow-up channel/time.

Use the contact information already associated with the interaction rather than repeatedly asking for it.

Ask one relevant question at a time, retain multiple answers and corrections, and do not guess missing values.

Save confirmed information using enabled lead actions and only acknowledge successful saves.

Respect refusals and opt-outs. Do not invent prices, availability, discounts or appointments.

Summarize collected requirements and arrange the permitted next step or human follow-up.`;

const fields = parseLeadFieldSchema([
  {
    key: "preferred_name",
    label: "Preferred name",
    type: "text",
    required: true,
  },
  { key: "company", label: "Company", type: "text", required: true },
]).fields;

describe("publication review", () => {
  it("lists exactly the actions the capabilities grant", () => {
    const review = reviewAgentPublication({
      prompt: coordinatorPrompt,
      capabilities: ["lead.write", "lead.finalize", "lead.follow_up"],
      leadFields: fields,
    });
    expect(review.enabledActions.map((action) => action.name)).toEqual([
      "lead_read_state",
      "lead_save_fields",
      "lead_finalize_collection",
      "lead_request_follow_up",
    ]);
    expect(review.blocking).toEqual([]);
    // The coordinator promises saving, and holds the action that keeps it.
    expect(review.promptWarnings).toEqual([]);
    expect(review.leadFields.map((field) => field.key)).toEqual([
      "preferred_name",
      "company",
    ]);
  });

  it("warns when the prose promises a save the agent cannot perform", () => {
    const review = reviewAgentPublication({
      prompt: coordinatorPrompt,
      capabilities: [],
      leadFields: null,
    });
    expect(review.enabledActions).toEqual([]);
    expect(review.promptWarnings).toContain("lead_saving");
  });

  it("warns about bookings, payments and outbound messages no action can perform", () => {
    const review = reviewAgentPublication({
      prompt:
        "Book a demo meeting in the calendar, charge the deposit and send them a confirmation. " +
        "תקבע פגישה ללקוח ותשלח קישור.",
      capabilities: ["lead.write"],
      leadFields: fields,
    });
    expect(review.promptWarnings).toEqual(
      expect.arrayContaining(["booking", "payment", "outbound_message"]),
    );
  });

  it("marks a lead agent with no reviewed field list as blocked", () => {
    expect(
      reviewAgentPublication({
        prompt: "Collect details.",
        capabilities: ["lead.write"],
        leadFields: null,
      }).blocking,
    ).toEqual(["lead_schema_missing"]);
    expect(
      reviewAgentPublication({
        prompt: "Answer questions.",
        capabilities: [],
        leadFields: fields,
      }).blocking,
    ).toEqual(["lead_schema_without_capability"]);
  });

  it("does not claim a support or survey prompt is fully executable", () => {
    // Silence is not certification: a survey prompt with no action promises
    // gets no warning, and the review says nothing more than that.
    const review = reviewAgentPublication({
      prompt:
        "Ask three short questions about how the customer uses our product and thank them.",
      capabilities: [],
      leadFields: null,
    });
    expect(review).toEqual({
      enabledActions: [],
      leadFields: [],
      blocking: [],
      promptWarnings: [],
    });
  });
});
