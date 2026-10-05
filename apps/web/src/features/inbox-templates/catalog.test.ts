import { expect, it } from "vitest";
import { parseTemplatePage, renderTemplateText } from "./catalog";

function page(components: readonly unknown[][]) {
  return parseTemplatePage({
    data: components.map((parts, index) => ({
      id: String(index),
      name: "template",
      status: "APPROVED",
      category: "UTILITY",
      language: "he",
      components: parts,
    })),
  });
}

it("allows ordered body parameters but refuses malformed variables", () => {
  const parsed = page([
    [{ type: "BODY", text: "Hello {{1}}" }],
    [{ type: "BODY", text: "Hello {{2}}" }],
    [{ type: "BODY", text: "Hello {{name}}" }],
    [{ type: "FOOTER", text: "No body" }],
  ]);
  expect(parsed.templates.map((template) => template.draft)).toEqual([
    { parameterCount: 1 },
    null,
    null,
    null,
  ]);
  expect(parsed.templates.map((template) => template.unsupported)).toEqual([
    null,
    "parameter_gaps",
    "named_parameters",
    "missing_body",
  ]);
});

it("sends static buttons as approved and explains what the composer cannot fill", () => {
  const parsed = page([
    [
      { type: "HEADER", format: "TEXT", text: "Welcome" },
      { type: "BODY", text: "How can we help?" },
      { type: "FOOTER", text: "Fixture Service" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Support" },
          { type: "URL", text: "Website", url: "https://example.test" },
          { type: "PHONE_NUMBER", text: "Call us" },
        ],
      },
    ],
    [
      { type: "BODY", text: "Track your order" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "URL", text: "Track", url: "https://example.test/{{1}}" },
        ],
      },
    ],
    [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Hello" },
    ],
    [
      { type: "HEADER", format: "TEXT", text: "Hi {{1}}" },
      { type: "BODY", text: "Hello" },
    ],
    [
      { type: "BODY", text: "Code" },
      { type: "BUTTONS", buttons: [{ type: "COPY_CODE", text: "Copy" }] },
    ],
  ]);
  const [welcome, ...refused] = parsed.templates;
  expect(welcome).toMatchObject({
    header: "Welcome",
    body: "How can we help?",
    footer: "Fixture Service",
    preview: "Welcome\nHow can we help?\nFixture Service",
    draft: { parameterCount: 0 },
    unsupported: null,
    buttons: [
      { type: "QUICK_REPLY", text: "Support" },
      { type: "URL", text: "Website" },
      { type: "PHONE_NUMBER", text: "Call us" },
    ],
  });
  expect(refused.map((template) => template.unsupported)).toEqual([
    "button_parameters",
    "media_header",
    "header_parameters",
    "unsupported_component",
  ]);
  expect(refused.every((template) => template.draft === null)).toBe(true);
});

it("previews filled values and keeps unfilled placeholders visible", () => {
  expect(renderTemplateText("Hi {{1}}, order {{2}}", ["Dana", " "])).toBe(
    "Hi Dana, order {{2}}",
  );
});
