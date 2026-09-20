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
