import { describe, expect, it } from "vitest";

import {
  assertServiceCaseTransition,
  canTransitionServiceCase,
  mergeOcrProposal,
  missingIntakeFields,
  nextServiceCaseStatuses,
  reportCompletionErrors,
  sanitizeIntakeProposal,
} from "./field-service-domain.js";

describe("field service domain rules", () => {
  it("keeps unknown warranty explicit and requests every required fact", () => {
    expect(
      missingIntakeFields({
        customerName: "Dana",
        customerPhone: "+972500000000",
        nationalId: "001234567",
        storeName: "Central store",
        latitude: 32.08,
        longitude: 34.78,
        faultDescription: "The unit does not start",
        warrantyStatus: "unknown",
      }),
    ).toEqual(["warrantyStatus"]);
  });

  it("accepts only known bounded model-proposal fields", () => {
    expect(
      sanitizeIntakeProposal({
        customerName: "  Dana  ",
        tenantId: "attacker-selected-tenant",
        warrantyStatus: "probably",
        latitude: 500,
        faultDescription: "No power",
      }),
    ).toEqual({ customerName: "Dana", faultDescription: "No power" });
  });

  it("does not let OCR retries overwrite confirmed human corrections", () => {
    expect(
      mergeOcrProposal(
        { model: "HUMAN-42", serial: "OLD" },
        { model: "OCR-99", serial: "NEW", product: "Washer" },
        ["model"],
      ),
    ).toEqual({ model: "HUMAN-42", serial: "NEW", product: "Washer" });
  });

  it("enforces lifecycle transitions", () => {
    expect(canTransitionServiceCase("awaiting_scheduling", "scheduled")).toBe(
      true,
    );
    expect(canTransitionServiceCase("closed", "in_progress")).toBe(false);
    expect(() => assertServiceCaseTransition("closed", "in_progress")).toThrow(
      /Cannot move/u,
    );
    expect(nextServiceCaseStatuses("scheduled")).toEqual([
      "awaiting_scheduling",
      "in_progress",
      "cancelled",
    ]);
    expect(nextServiceCaseStatuses("closed")).toEqual([]);
  });

  it("requires attendance, evidence, repair details, and replacement details", () => {
    expect(
      reportCompletionErrors({
        arrivalSigned: true,
        departureSigned: true,
        hasFaultPhoto: true,
        hasModulePhoto: true,
        diagnosis: "Control board failure",
        workPerformed: "Replaced the board and tested the unit",
        partReplaced: true,
        replacementPartDetails: "",
      }),
    ).toEqual(["Replacement part details are required"]);
  });
});
