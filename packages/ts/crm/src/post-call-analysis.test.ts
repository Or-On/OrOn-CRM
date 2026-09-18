import { describe, expect, it } from "vitest";

import {
  classifyCustomerReply,
  decideTicketResolution,
  parsePostCallAnalysis,
  PostCallAnalysisError,
  type AuthoritativeEvidence,
  type PostCallAnalysis,
} from "./post-call-analysis.js";

const evidence: AuthoritativeEvidence = {
  transcriptTurnCount: 12,
  whatsAppMessageIds: ["11111111-1111-4111-8111-111111111111"],
  actionReceiptIds: ["22222222-2222-4222-8222-222222222222"],
  operatorNoteIds: [],
};

function output(overrides: Record<string, unknown> = {}): unknown {
  return {
    issue: "Internet drops every evening.",
    customerFacts: [],
    priorContext: [],
    actionsAttempted: [],
    actionsCompleted: [],
    unresolvedItems: [],
    commitments: [],
    nextAction: null,
    recommendedOwner: null,
    sentiment: null,
    sentimentSources: [],
    resolution: "unresolved",
    resolutionConfirmationSource: "none",
    classificationConfidence: "medium",
    classificationSources: [{ kind: "transcript_turn", reference: "7" }],
    ...overrides,
  };
}

function analysis(overrides: Partial<PostCallAnalysis> = {}): PostCallAnalysis {
  return { ...parsePostCallAnalysis(output(), evidence), ...overrides };
}

describe("post-call analysis contract", () => {
  it("keeps a claim whose source resolves against real evidence", () => {
    const parsed = parsePostCallAnalysis(
      output({
        customerFacts: [
          {
            statement: "The customer said the router was restarted.",
            sources: [{ kind: "transcript_turn", reference: "4" }],
          },
        ],
      }),
      evidence,
    );

    expect(parsed.customerFacts).toHaveLength(1);
    expect(parsed.customerFacts[0]?.sources[0]?.reference).toBe("4");
  });

  it("drops a claim that cites a transcript turn the call never had", () => {
    const parsed = parsePostCallAnalysis(
      output({
        customerFacts: [
          {
            statement: "The customer confirmed the replacement arrived.",
            sources: [{ kind: "transcript_turn", reference: "400" }],
          },
        ],
      }),
      evidence,
    );

    // A citation to turn 400 of a twelve-turn call is a fabrication, however
    // plausible the sentence reads.
    expect(parsed.customerFacts).toHaveLength(0);
  });

  it("drops a claim with no source at all", () => {
    const parsed = parsePostCallAnalysis(
      output({
        customerFacts: [
          { statement: "The customer is on a business plan.", sources: [] },
        ],
      }),
      evidence,
    );

    expect(parsed.customerFacts).toHaveLength(0);
  });

  it("refuses a completed action whose receipt the platform never issued", () => {
    const parsed = parsePostCallAnalysis(
      output({
        actionsCompleted: [
          {
            action: "Technician appointment created for Tuesday.",
            receipt: { kind: "action_receipt", reference: "APPT-4821" },
          },
        ],
      }),
      evidence,
    );

    expect(parsed.actionsCompleted).toHaveLength(0);
  });

  it("refuses a completed action sourced to something the agent merely said", () => {
    const parsed = parsePostCallAnalysis(
      output({
        actionsCompleted: [
          {
            action: "Technician appointment created.",
            receipt: { kind: "transcript_turn", reference: "9" },
          },
        ],
      }),
      evidence,
    );

    // The turn is real; a sentence in a call is still not a booking.
    expect(parsed.actionsCompleted).toHaveLength(0);
  });

  it("accepts a completed action backed by a platform receipt", () => {
    const parsed = parsePostCallAnalysis(
      output({
        actionsCompleted: [
          {
            action: "A service case was opened for the visit.",
            receipt: {
              kind: "action_receipt",
              reference: "22222222-2222-4222-8222-222222222222",
            },
          },
        ],
      }),
      evidence,
    );

    expect(parsed.actionsCompleted).toHaveLength(1);
  });

  it("discards sentiment that nothing in the call evidences", () => {
    const parsed = parsePostCallAnalysis(
      output({ sentiment: "positive", sentimentSources: [] }),
      evidence,
    );

    expect(parsed.sentiment).toBeNull();
  });

  it("rejects an analysis whose resolution is not a state we recognise", () => {
    expect(() =>
      parsePostCallAnalysis(
        output({ resolution: "mostly_resolved" }),
        evidence,
      ),
    ).toThrow(PostCallAnalysisError);
  });
});

describe("resolution rules", () => {
  it("never resolves a call nobody answered", () => {
    const decision = decideTicketResolution({
      analysis: analysis({
        resolution: "resolved",
        resolutionConfirmationSource: "customer_call",
        classificationConfidence: "high",
      }),
      callOutcome: "no_answer",
      transcriptState: "missing",
    });

    expect(decision.resolution).toBe("unresolved");
    expect(decision.confirmedBy).toBe("none");
    expect(decision.reason).toBe("call_outcome_no_answer");
    expect(decision.askCustomer).toBe(false);
  });

  it("resolves only when the customer confirmed it on the call, with the turn", () => {
    const decision = decideTicketResolution({
      analysis: analysis({
        resolution: "resolved",
        resolutionConfirmationSource: "customer_call",
        classificationConfidence: "high",
        classificationSources: [{ kind: "transcript_turn", reference: "11" }],
      }),
      callOutcome: "answered",
      transcriptState: "valid",
    });

    expect(decision.resolution).toBe("resolved");
    expect(decision.confirmedBy).toBe("customer");
    // Still open: the wrap-up is about to give the customer a chance to object.
    expect(decision.stage).toBe("awaiting_customer");
    expect(decision.askCustomer).toBe(true);
  });

  it("demotes a resolution the model asserted without citing the call", () => {
    const decision = decideTicketResolution({
      analysis: analysis({
        resolution: "resolved",
        resolutionConfirmationSource: "customer_call",
        classificationConfidence: "high",
        classificationSources: [],
      }),
      callOutcome: "answered",
      transcriptState: "valid",
    });

    expect(decision.resolution).toBe("proposed_fix_awaiting_confirmation");
    expect(decision.confirmedBy).toBe("none");
    expect(decision.reason).toBe("resolution_claimed_without_evidence");
  });

  it("demotes a confident resolution when no transcript backs it", () => {
    const decision = decideTicketResolution({
      analysis: analysis({
        resolution: "resolved",
        resolutionConfirmationSource: "customer_call",
        classificationConfidence: "high",
        classificationSources: [{ kind: "transcript_turn", reference: "11" }],
      }),
      callOutcome: "answered",
      transcriptState: "missing",
    });

    expect(decision.resolution).toBe("proposed_fix_awaiting_confirmation");
  });

  it("leaves a proposed fix awaiting the customer rather than closing it", () => {
    const decision = decideTicketResolution({
      analysis: analysis({
        resolution: "proposed_fix_awaiting_confirmation",
      }),
      callOutcome: "answered",
      transcriptState: "valid",
    });

    expect(decision.resolution).toBe("proposed_fix_awaiting_confirmation");
    expect(decision.askCustomer).toBe(true);
    expect(decision.requiresHuman).toBe(false);
  });

  it("treats a disconnect after a proposed fix as unconfirmed", () => {
    const decision = decideTicketResolution({
      analysis: analysis({
        resolution: "resolved",
        resolutionConfirmationSource: "customer_call",
        classificationConfidence: "high",
        classificationSources: [{ kind: "transcript_turn", reference: "11" }],
      }),
      callOutcome: "disconnected",
      transcriptState: "partial",
    });

    expect(decision.resolution).toBe("unresolved");
    expect(decision.reason).toBe("call_outcome_disconnected");
  });

  it("hands the issue to a person when the customer asked for one", () => {
    const decision = decideTicketResolution({
      analysis: analysis({ resolution: "needs_human" }),
      callOutcome: "answered",
      transcriptState: "valid",
    });

    expect(decision.requiresHuman).toBe(true);
    expect(decision.stage).toBe("awaiting_human");
    expect(decision.askCustomer).toBe(false);
  });

  it("falls back to unresolved when no analysis could be produced", () => {
    const decision = decideTicketResolution({
      analysis: undefined,
      callOutcome: "answered",
      transcriptState: "valid",
    });

    expect(decision.resolution).toBe("unresolved");
    expect(decision.reason).toBe("analysis_unavailable");
  });

  it("sends a duplicate or cancellation to a person instead of acting on it", () => {
    const decision = decideTicketResolution({
      analysis: analysis({ resolution: "duplicate" }),
      callOutcome: "answered",
      transcriptState: "valid",
    });

    expect(decision.requiresHuman).toBe(true);
    expect(decision.resolution).toBe("unresolved");
  });
});

describe("wrap-up reply classification", () => {
  it("reads the numbered choices the message offered", () => {
    expect(classifyCustomerReply("1")).toBe("confirmed_resolved");
    expect(classifyCustomerReply("2")).toBe("still_broken");
    expect(classifyCustomerReply("3")).toBe("wants_human");
  });

  it("reads a Hebrew confirmation and a Hebrew denial", () => {
    expect(classifyCustomerReply("כן, עכשיו זה עובד")).toBe(
      "confirmed_resolved",
    );
    expect(classifyCustomerReply("לא, עדיין יש תקלה")).toBe("still_broken");
    expect(classifyCustomerReply("נציג")).toBe("wants_human");
  });

  it("puts a request for a person ahead of the fault report around it", () => {
    expect(classifyCustomerReply("עדיין לא עובד, תעבירו אותי לנציג")).toBe(
      "wants_human",
    );
  });

  it("stays unclear on a new problem rather than answering the old question", () => {
    expect(classifyCustomerReply("אגב, גם החשבונית של החודש שעבר שגויה")).toBe(
      "unclear",
    );
    expect(
      classifyCustomerReply("Actually I also need to change my address"),
    ).toBe("unclear");
  });

  it("stays unclear on empty or oversized text", () => {
    expect(classifyCustomerReply("   ")).toBe("unclear");
    expect(classifyCustomerReply("solved ".repeat(20))).toBe("unclear");
  });
});
