// @vitest-environment node
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../src/app/field-service.css", import.meta.url),
  "utf8",
);

describe("field-service responsive layout", () => {
  it("mirrors report row navigation affordances at every RTL viewport", () => {
    const rtlRule = css.indexOf(
      '[dir="rtl"] .field-service-row-actions > a svg',
    );
    const mobileDirectory = css.indexOf("@media (max-width: 48rem)");

    expect(rtlRule).toBeGreaterThan(-1);
    expect(rtlRule).toBeLessThan(mobileDirectory);
  });
});
