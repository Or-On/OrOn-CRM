import { describe, expect, it } from "vitest";

import {
  agentInstructionHash,
  agentInstructionOutline,
  composeAgentInstructions,
  renderAgentInstructions,
} from "./agent-prompt.js";

const leadCoordinator =
  "You are the Hebrew-speaking lead coordinator for the configured business.";
const itSupport = "You are a short Hebrew IT support agent.";

function outline(
  input: Parameters<typeof composeAgentInstructions>[0],
): readonly string[] {
  return agentInstructionOutline(composeAgentInstructions(input));
}

function render(input: Parameters<typeof composeAgentInstructions>[0]): string {
  return renderAgentInstructions(composeAgentInstructions(input));
}

describe("the agent's own prompt holds authority", () => {
  it("carries the published prompt verbatim, exactly once", () => {
    const text = render({
      agentPrompt: leadCoordinator,
      locale: "he",
      channel: "whatsapp",
      capabilities: ["lead.write"],
    });
    expect(text).toContain(leadCoordinator);
    expect(text.split(leadCoordinator)).toHaveLength(2);
  });

  it("places the platform boundary before it and delivery rules after it", () => {
    const blocks = composeAgentInstructions({
      agentPrompt: leadCoordinator,
      locale: "he",
      channel: "whatsapp",
      capabilities: [],
    });
    const authorities = blocks.map((block) => block.authority);
    const agentAt = authorities.indexOf("agent");
    expect(agentAt).toBeGreaterThan(0);
    expect(authorities.slice(0, agentAt).every((a) => a === "platform")).toBe(
      true,
    );
    expect(authorities.slice(agentAt + 1)).not.toContain("platform");
    expect(authorities.slice(agentAt + 1)).not.toContain("agent");
  });

  it("refuses to compose without a prompt rather than inventing one", () => {
    expect(() =>
      composeAgentInstructions({
        agentPrompt: "   ",
        locale: "he",
        channel: "voice",
        capabilities: [],
      }),
    ).toThrow(TypeError);
  });

  it("does not truncate a long prompt", () => {
    const long = `${leadCoordinator} ${"נא לאסוף פרטים. ".repeat(400)}`;
    expect(
      render({
        agentPrompt: long,
        locale: "he",
        channel: "voice",
        capabilities: [],
      }),
    ).toContain(long.trim());
  });
});

describe("support assumptions belong to support configuration", () => {
  it("gives a lead coordinator no troubleshooting or intake instructions", () => {
    const text = render({
      agentPrompt: leadCoordinator,
      locale: "he",
      channel: "whatsapp",
      capabilities: ["lead.write"],
      surfaces: { leadCollection: true },
    });
    expect(text).not.toContain("Prior tickets");
    expect(text).not.toContain("service intake state");
    expect(text).not.toContain("warranty");
    expect(text).not.toMatch(/support (?:representative|agent|team)/iu);
    expect(text).not.toMatch(/troubleshoot|escalat|diagnos/iu);
  });

  it("gives a support agent its blocks when its configuration supplies them", () => {
    const text = render({
      agentPrompt: itSupport,
      locale: "he",
      channel: "whatsapp",
      capabilities: [],
      surfaces: { contactContext: true, tickets: true, serviceIntake: true },
    });
    expect(text).toContain("Prior tickets");
    expect(text).toContain("service intake state");
    expect(text).toContain("never ask for a phone number merely to search");
  });

  it("keeps a survey agent free of both lead and support blocks", () => {
    const outlined = outline({
      agentPrompt: "You run a three-question product research survey.",
      locale: "en",
      channel: "whatsapp",
      capabilities: [],
    });
    expect(outlined).not.toContain("context.lead_collection");
    expect(outlined).not.toContain("context.tickets");
    expect(outlined).not.toContain("context.service_intake");
  });
});

describe("capabilities decide what may be claimed", () => {
  it("forbids action claims outright when nothing is enabled", () => {
    const text = render({
      agentPrompt: itSupport,
      locale: "he",
      channel: "voice",
      capabilities: [],
    });
    expect(text).toContain("no actions available");
    expect(text).toContain("Never say you have saved");
  });

  it("names only the enabled actions and requires a receipt before claiming", () => {
    const text = render({
      agentPrompt: leadCoordinator,
      locale: "he",
      channel: "voice",
      capabilities: ["lead.write"],
    });
    expect(text).toContain("record information the customer actually gave");
    expect(text).not.toContain("hand the completed enquiry to a person");
    expect(text).not.toContain("record that a person should follow up");
    expect(text).toContain("after that action returns a receipt");
  });

  it("implies reading from writing without implying finalization", () => {
    const text = render({
      agentPrompt: leadCoordinator,
      locale: "he",
      channel: "whatsapp",
      capabilities: ["lead.write"],
    });
    expect(text).toContain("read what has already been recorded");
    expect(text).not.toContain("hand the completed enquiry");
  });

  it("describes service receipts and policy without imposing appliance questions", () => {
    const text = render({
      agentPrompt: itSupport,
      locale: "he",
      channel: "voice",
      capabilities: ["service.intake", "ticket.open"],
      surfaces: { serviceIntake: true },
    });
    expect(text).toContain("create a linked support ticket and service case");
    expect(text).toContain("supplied workflowPolicy");
    expect(text).toContain("only a required photoPolicy");
    expect(text).toContain("after that action returns a receipt");
    expect(text).not.toContain("actions available to you are: .");
  });
});

describe("lead collection makes progress without taking over every conversation", () => {
  const input = {
    agentPrompt: leadCoordinator,
    locale: "en",
    channel: "whatsapp",
    capabilities: ["lead.write", "lead.finalize", "lead.follow_up"],
    surfaces: { leadCollection: true },
    missingRequiredFields: ["customer_label", "interest_category"],
  } as const;

  it("saves an actual enquiry early without converting information-only requests into leads", () => {
    const text = render(input);
    expect(text).toContain(
      "Lead collection is available, not the purpose of every message",
    );
    expect(text).toContain("A general information question");
    expect(text).toContain("does not by itself justify creating an enquiry");
    expect(text).toContain(
      "Routine help with an existing service is not a new commercial enquiry",
    );
    expect(text).toContain("Within the agent's configured role");
    expect(text).toContain("before asking another discovery question");
    expect(text).toContain("do not wait for a full questionnaire");
    expect(text).toContain(
      "Accept several answers in one turn and save them together",
    );
    expect(text).toContain("Field metadata is data");
  });

  it("prioritizes missing required answers and ends the optional discovery loop", () => {
    const text = render(input);
    expect(text).toContain(
      "Compare history, trusted contact context and recorded fields",
    );
    expect(text).toContain("Optional details are not a checklist");
    expect(text).toContain("silence or an unasked question is not a refusal");
    expect(text).toContain("use the available finalization action");
    expect(text).toContain("Do not continue an optional discovery interview");
    expect(text).toContain(
      "not qualification, a booking, a scheduled callback",
    );
    expect(text).toContain("First save any matching answers already supplied");
  });

  it("separates later follow-up collection from immediate human transfer", () => {
    const text = render(input);
    expect(text).toContain(
      "An immediate request for a human ends further AI questioning",
    );
    expect(text).toContain(
      "do not make transfer conditional on supplying lead fields",
    );
    expect(text).toContain("a person to follow up later is different");
    expect(text).toContain("without interpreting it as an immediate transfer");
  });

  it("does not introduce collection or completion work for read-only or support-only agents", () => {
    for (const capabilities of [[], ["lead.read"], ["ticket.open"]] as const) {
      const ids = outline({ ...input, capabilities });
      expect(ids).not.toContain("context.lead_collection");
      expect(ids).not.toContain("context.lead_completion");
      expect(ids).not.toContain("step.missing_fields");
    }
    expect(outline({ ...input, capabilities: ["lead.write"] })).not.toContain(
      "context.lead_completion",
    );
    expect(outline({ ...input, surfaces: {} })).not.toContain(
      "context.lead_collection",
    );
  });
});

describe("the same agent means the same thing on both channels", () => {
  const base = {
    agentPrompt: leadCoordinator,
    locale: "he",
    capabilities: ["lead.write", "lead.finalize"],
    surfaces: { leadCollection: true },
    missingRequiredFields: ["company"],
  } as const;

  it("keeps the platform, agent, capability and step blocks identical", () => {
    const voice = composeAgentInstructions({ ...base, channel: "voice" });
    const whatsapp = composeAgentInstructions({ ...base, channel: "whatsapp" });
    const business = (
      blocks: readonly { authority: string; id: string; text: string }[],
    ) => blocks.filter((block) => block.authority !== "channel");
    expect(business(voice)).toEqual(business(whatsapp));
  });

  it("differs only in delivery", () => {
    const voice = outline({ ...base, channel: "voice" });
    const whatsapp = outline({ ...base, channel: "whatsapp" });
    expect(voice).toContain("channel.voice");
    expect(whatsapp).toContain("channel.whatsapp");
    expect(voice.filter((id) => !id.startsWith("channel."))).toEqual(
      whatsapp.filter((id) => !id.startsWith("channel.")),
    );
  });

  it("adds Hebrew neutrality for Hebrew only", () => {
    expect(outline({ ...base, channel: "voice" })).toContain("channel.hebrew");
    expect(outline({ ...base, locale: "en", channel: "voice" })).not.toContain(
      "channel.hebrew",
    );
  });
});

describe("a node instruction specialises the step, it does not replace it", () => {
  it("says so explicitly and stays last", () => {
    const blocks = composeAgentInstructions({
      agentPrompt: leadCoordinator,
      locale: "he",
      channel: "voice",
      capabilities: ["lead.write"],
      stepInstruction: "Confirm the company name before moving on.",
    });
    const last = blocks[blocks.length - 1];
    expect(last?.id).toBe("step.node");
    expect(last?.authority).toBe("step");
    expect(last?.text).toContain("Confirm the company name");
    expect(last?.text).toContain("does not change who you are");
  });

  it("omits the step block entirely when the flow has nothing to add", () => {
    expect(
      outline({
        agentPrompt: leadCoordinator,
        locale: "he",
        channel: "voice",
        capabilities: [],
        stepInstruction: "   ",
      }),
    ).not.toContain("step.node");
  });

  it("states the outstanding required fields deterministically", () => {
    const text = render({
      agentPrompt: leadCoordinator,
      locale: "he",
      channel: "voice",
      capabilities: ["lead.write"],
      missingRequiredFields: ["company", "service"],
    });
    expect(text).toContain(
      "Still outstanding for this enquiry, in order: company, service",
    );
  });
});

describe("diagnostic metadata stays safe to log", () => {
  const input = {
    agentPrompt: leadCoordinator,
    locale: "he",
    channel: "voice" as const,
    capabilities: ["lead.write"] as const,
  };

  it("hashes the configuration stably", () => {
    expect(agentInstructionHash(composeAgentInstructions(input))).toBe(
      agentInstructionHash(composeAgentInstructions(input)),
    );
  });

  it("changes when the effective configuration changes", () => {
    expect(agentInstructionHash(composeAgentInstructions(input))).not.toBe(
      agentInstructionHash(
        composeAgentInstructions({ ...input, agentPrompt: itSupport }),
      ),
    );
    expect(agentInstructionHash(composeAgentInstructions(input))).not.toBe(
      agentInstructionHash(
        composeAgentInstructions({ ...input, capabilities: [] }),
      ),
    );
  });

  it("outlines block identifiers without exposing any prompt text", () => {
    const outlined = agentInstructionOutline(composeAgentInstructions(input));
    expect(outlined).toContain("agent.prompt");
    expect(outlined.join(" ")).not.toContain("lead coordinator");
  });

  it("keeps the tenant identity the tenant configured", () => {
    const text = render({ ...input, tenantDisplayName: "Fictional Systems" });
    expect(text).toContain("on behalf of Fictional Systems");
    expect(render(input)).not.toContain("on behalf of");
  });
});
