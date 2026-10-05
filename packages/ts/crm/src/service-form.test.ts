import { describe, expect, it } from "vitest";
import { parseServiceWorkflowPolicy } from "./service-workflow.js";
import { parseServiceFormFields } from "./service-form.js";

it("accepts only known distinct configuration field names", () => {
  expect(parseServiceFormFields(undefined)).toBeUndefined();
  expect(parseServiceFormFields(["storeName", "faultDescription"])).toEqual([
    "storeName",
    "faultDescription",
  ]);
  for (const value of [[], ["storeName", "storeName"], ["nationalId"], "x"])
    expect(() => parseServiceFormFields(value)).toThrow(TypeError);
});

describe("WhatsApp form mode in the service workflow", () => {
  const base = {
    version: 1,
    requiredIntakeFields: ["customerName", "faultDescription"],
    photoPolicy: "requested",
    selfAssignmentEnabled: true,
    requiredReportFields: ["diagnosis"],
  };
  const followUp = {
    enabled: true,
    trigger: "intake_saved",
    requestPhoto: true,
    consent: "in_call_agreement",
  };

  it("keeps the configured mode and fields", () => {
    expect(
      parseServiceWorkflowPolicy({
        ...base,
        whatsappFollowUp: {
          ...followUp,
          mode: "form",
          formFields: ["serviceLocation", "storeName"],
        },
      }).whatsappFollowUp,
    ).toEqual({
      ...followUp,
      mode: "form",
      formFields: ["serviceLocation", "storeName"],
    });
    expect(
      parseServiceWorkflowPolicy({ ...base, whatsappFollowUp: followUp })
        .whatsappFollowUp,
    ).toEqual(followUp);
  });

  it("rejects unknown modes and form fields outside form mode", () => {
    for (const whatsappFollowUp of [
      { ...followUp, mode: "chat" },
      { ...followUp, formFields: ["storeName"] },
      { ...followUp, mode: "summary", formFields: ["storeName"] },
      { ...followUp, mode: "form", formFields: ["nationalId"] },
    ])
      expect(() =>
        parseServiceWorkflowPolicy({ ...base, whatsappFollowUp }),
      ).toThrow(TypeError);
  });
});
