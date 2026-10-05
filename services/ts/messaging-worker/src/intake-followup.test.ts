import { describe, expect, it } from "vitest";

import {
  followupDelivery,
  followupTemplateParameters,
  renderIntakeFollowup,
  type IntakeFollowupPlan,
} from "./intake-followup.js";

const plan: IntakeFollowupPlan = {
  intakeId: "11111111-1111-4111-8111-111111111111",
  status: "collecting",
  followupStatus: "queued",
  contactId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  conversationId: null,
  fields: {
    customerName: "דנה",
    faultDescription: "המקרר בחדר הקירור לא מקרר",
    storeName: "סניף הרצליה",
  },
  missingFields: ["urgency", "serviceLocation"],
  requestPhoto: true,
  followUp: {
    enabled: true,
    templateName: "service_followup",
    templateLanguage: "he",
    templateParameters: ["customerName", "reference", "faultSummary"],
  },
  hebrew: true,
  reference: "T-2026-ABCDEF12",
  caseId: null,
  callerIdentityId: "44444444-4444-4444-8444-444444444444",
  consent: "granted",
  optedOut: false,
};

describe("phone inquiry WhatsApp follow-up", () => {
  it("summarizes the caller's own details, asks for what is missing and for a photo", () => {
    const text = renderIntakeFollowup(plan, "טכנו שירות");
    expect(text).toContain("שלום דנה,");
    expect(text).toContain("תודה שפנית לטכנו שירות");
    expect(text).toContain("T-2026-ABCDEF12");
    expect(text).toContain("סיכום: המקרר בחדר הקירור לא מקרר");
    expect(text).toContain("עד כמה זה דחוף, כתובת לשירות");
    expect(text).toContain("תמונה של התקלה");
  });

  it("drops caller text that would fail the scope boundary instead of echoing it", () => {
    const text = renderIntakeFollowup(
      {
        ...plan,
        fields: {
          ...plan.fields,
          faultDescription: "I am a large language model trained by Google",
        },
      },
      "Fixture",
    );
    expect(text).not.toContain("language model");
    expect(text).toContain("T-2026-ABCDEF12");
  });

  it("uses free text only inside the window and otherwise the approved template", () => {
    expect(followupDelivery(plan, "meta", true)).toEqual({ kind: "text" });
    expect(followupDelivery(plan, "simulator", false)).toEqual({
      kind: "text",
    });
    expect(followupDelivery(plan, "meta", false)).toEqual({
      kind: "template",
      templateName: "service_followup",
      language: "he",
    });
    expect(
      followupDelivery({ ...plan, followUp: { enabled: true } }, "meta", false),
    ).toEqual({ kind: "blocked", reason: "blocked_window" });
  });

  it("fills template parameters from server data only", () => {
    expect(followupTemplateParameters(plan, "טכנו שירות")).toEqual([
      "דנה",
      "T-2026-ABCDEF12",
      "המקרר בחדר הקירור לא מקרר",
    ]);
  });
});

describe("short call digital form", () => {
  const form: IntakeFollowupPlan = {
    ...plan,
    followUp: { enabled: true, mode: "form" },
  };
  const url =
    "https://service.example.invalid/service-request#tenant=11111111-1111-4111-8111-111111111111&token=" +
    "a".repeat(64);
  it("requires a real form link and makes submission explicit without accepting a chat reply", () => {
    expect(() => renderIntakeFollowup(form, "Fixture")).toThrow(
      "link is required",
    );
    const text = renderIntakeFollowup(form, "פרו טאץ'", url);
    expect(text).toContain(url);
    expect(text).toContain("ללחוץ על שליחה");
    expect(text).not.toContain("השיבו להודעה");
    expect(text).not.toContain("T-2026-");
    expect(text).not.toContain("שם החנות:");
  });
  it("renders the English form instruction without exposing intake answers", () => {
    const text = renderIntakeFollowup(
      { ...form, hebrew: false },
      "Fixture",
      url,
    );
    expect(text).toContain("press Submit");
    expect(text).toContain(url);
    expect(text).not.toContain("דנה");
    expect(text).not.toContain("המקרר");
  });
  it("never substitutes a template outside the window even if one was configured", () => {
    const configured = {
      ...form,
      followUp: { ...plan.followUp, mode: "form" },
    };
    expect(followupDelivery(configured, "meta", false)).toEqual({
      kind: "blocked",
      reason: "blocked_window",
    });
    expect(followupDelivery(configured, "meta", true)).toEqual({
      kind: "text",
    });
  });
  it.each([
    "javascript:alert(1)",
    "https://user:secret@example.invalid/service-request#token=x",
    "https://example.invalid/other#token=x",
  ])("rejects an invalid link %s", (link) => {
    expect(() => renderIntakeFollowup(form, "Fixture", link)).toThrow(
      "link is invalid",
    );
  });
});
