import { describe, expect, it } from "vitest";
import {
  missingIntakeFields,
  reportCompletionErrors,
  sanitizeIntakeProposal,
} from "./field-service-domain.js";
import {
  parseServiceWorkflowPolicy,
  retailServiceWorkflowPolicy,
  serviceWorkflowDefaults,
} from "./service-workflow.js";

describe("published service workflow policy", () => {
  it("retains legacy requirements without tenant configuration", () => {
    expect(parseServiceWorkflowPolicy(undefined)).toEqual(
      serviceWorkflowDefaults,
    );
    expect(missingIntakeFields({})).toContain("nationalId");
  });
  it("retail intake asks for the actual failure without collecting unrelated identity and warranty", () => {
    const fields = {
      customerName: "Fixture",
      customerPhone: "+972500000001",
      chainName: "Retail",
      storeName: "North",
      faultDescription: "Printer fault",
    };
    expect(
      missingIntakeFields(
        fields,
        [],
        retailServiceWorkflowPolicy.requiredIntakeFields,
      ),
    ).toEqual(["exactFailure"]);
    expect(
      missingIntakeFields(
        { ...fields, exactFailure: "Blank paper" },
        [],
        retailServiceWorkflowPolicy.requiredIntakeFields,
      ),
    ).toEqual([]);
  });
  it("rejects invalid and model-controlled configuration keys", () => {
    for (const value of [
      { ...retailServiceWorkflowPolicy, selfAssignmentEnabled: "true" },
      { ...retailServiceWorkflowPolicy, tenantId: "foreign" },
      { ...retailServiceWorkflowPolicy, requiredIntakeFields: [] },
      { ...retailServiceWorkflowPolicy, requiredReportFields: ["executeSql"] },
    ])
      expect(() => parseServiceWorkflowPolicy(value)).toThrow(TypeError);
  });
  it("accepts a selected directory store as a service location without asking for its address again", () => {
    expect(
      missingIntakeFields(
        {
          storeId: "bdcfd032-4d1f-4b30-9975-aee1da06f518",
          faultDescription: "Printer stopped",
        },
        [],
        ["serviceLocation", "faultDescription"],
      ),
    ).toEqual([]);
  });
  it("report requirements follow policy and parts still require details when replaced", () => {
    const facts = {
      arrivalSigned: false,
      departureSigned: false,
      hasFaultPhoto: true,
      hasModulePhoto: false,
      diagnosis: "Paper feed failed",
      workPerformed: "Replaced roller",
      partReplaced: true,
    };
    expect(
      reportCompletionErrors(
        facts,
        retailServiceWorkflowPolicy.requiredReportFields,
      ),
    ).toEqual(["Replacement part details are required"]);
    expect(
      reportCompletionErrors(
        { ...facts, replacementPartDetails: "Roller R-1" },
        retailServiceWorkflowPolicy.requiredReportFields,
      ),
    ).toEqual([]);
  });
  it("projects bounded retail facts and rejects invented store identifiers", () => {
    expect(
      sanitizeIntakeProposal({
        chainName: " Retail ",
        storeId: "not-a-uuid",
        exactFailure: "Blank paper",
        status: "confirmed",
      }),
    ).toEqual({ chainName: "Retail", exactFailure: "Blank paper" });
  });
});

describe("configurable field operations policy", () => {
  const full = {
    version: 1,
    requiredIntakeFields: ["customerName", "faultDescription", "urgency"],
    photoPolicy: "requested",
    selfAssignmentEnabled: true,
    requiredReportFields: ["diagnosis", "workPerformed"],
    inquiry: { openOnFirstContact: true },
    whatsappFollowUp: {
      enabled: true,
      trigger: "call_ended",
      requestPhoto: true,
      consent: "in_call_agreement",
      templateName: "service_followup",
      templateLanguage: "he",
      templateParameters: ["customerName", "reference"],
    },
    emergency: {
      enabled: true,
      label: "קריאה אדומה",
      manualRedCall: true,
      transferTo: "+972501111111",
      fallback: "urgent_followup",
    },
    preparation: {
      enabled: true,
      requireAcknowledgement: true,
      checklist: [{ key: "spare_board", label: "Spare board", required: true }],
    },
    attachmentCategories: [
      { key: "rcg", label: "RCG", accept: ["pdf", "image"] },
    ],
    evidence: { beforePhotoRequired: true, afterPhotoRequired: true },
  };

  it("accepts every optional capability and keeps absent keys absent", () => {
    expect(parseServiceWorkflowPolicy(full)).toEqual(full);
    const legacy = parseServiceWorkflowPolicy(retailServiceWorkflowPolicy);
    expect(Object.keys(legacy)).not.toContain("emergency");
  });

  it.each([
    { ...full, unknown: true },
    { ...full, emergency: { ...full.emergency, transferTo: "0501234567" } },
    { ...full, emergency: { ...full.emergency, label: "" } },
    {
      ...full,
      whatsappFollowUp: {
        ...full.whatsappFollowUp,
        templateLanguage: undefined,
      },
    },
    {
      ...full,
      attachmentCategories: [
        { key: "before_photo", label: "x", accept: ["pdf"] },
      ],
    },
    {
      ...full,
      attachmentCategories: [{ key: "rcg", label: "RCG", accept: ["exe"] }],
    },
    {
      ...full,
      preparation: {
        ...full.preparation,
        checklist: [{ key: "A B", label: "x", required: true }],
      },
    },
    {
      ...full,
      evidence: { beforePhotoRequired: "yes", afterPhotoRequired: true },
    },
  ])("rejects malformed policy %#", (policy) => {
    expect(() =>
      parseServiceWorkflowPolicy(JSON.parse(JSON.stringify(policy)) as unknown),
    ).toThrow(TypeError);
  });
});
