import { expect, it } from "vitest";
import { parseTemplatePage } from "./catalog";

it("allows ordered body parameters but refuses unsupported or malformed components", () => {
  const parts = [
    [{ type: "BODY", text: "Hello {{1}}" }],
    [{ type: "BODY", text: "Hello {{2}}" }],
    [{ type: "BODY", text: "Hello {{name}}" }],
    [
      { type: "BODY", text: "Hello" },
      { type: "HEADER", format: "IMAGE" },
    ],
    [
      { type: "BODY", text: "Hello" },
      { type: "BUTTONS", buttons: [] },
    ],
  ];
  const page = parseTemplatePage({
    data: parts.map((components, index) => ({
      id: String(index),
      name: "template",
      status: "APPROVED",
      category: "UTILITY",
      language: "he",
      components,
    })),
  });
  expect(page.templates.map((template) => template.draft)).toEqual([
    { parameterCount: 1 },
    null,
    null,
    null,
    null,
  ]);
});
