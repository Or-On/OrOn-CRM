import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  serviceFormMessage,
  serviceFormTemplateV2Body,
} from "./service-form-message.js";
it("the reviewed three-parameter Meta body exactly matches runtime punctuation and parameter order", () => {
  const payload = JSON.parse(
    readFileSync(
      new URL(
        "../../../../infra/tenant-configurations/protouch.service-template-v2.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    language: string;
    components: [
      { text: string; example: { body_text: [[string, string, string]] } },
    ];
  };
  expect(payload.components[0].text).toBe(serviceFormTemplateV2Body);
  expect(payload.language).toBe("he");
  const [name, link, phone] = payload.components[0].example.body_text[0];
  const rendered = serviceFormTemplateV2Body
    .replace("{{1}}", name)
    .replace("{{2}}", link)
    .replace("{{3}}", phone);
  expect(
    serviceFormMessage(
      { businessName: name, businessPhone: phone },
      link,
      "https://dev.or-on.io",
    ),
  ).toBe(rendered);
  expect(rendered.endsWith(".")).toBe(true);
});
