// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../src/app/workspace-details.css", import.meta.url),
  "utf8",
);

describe("call timeline compact layout", () => {
  it("allows canonical event identifiers to wrap within their grid track", () => {
    const identifier =
      /\.call-detail-timeline \.timeline li > div > strong\s*\{([^}]+)\}/u.exec(
        css,
      )?.[1];
    expect(identifier).toContain("min-inline-size: 0;");
    expect(identifier).toContain("overflow-wrap: anywhere;");
  });

  it("stacks the event identifier and timestamp at compact widths", () => {
    expect(css).toMatch(
      /@media \(max-width: 46rem\)\s*\{\s*\.call-detail-timeline \.timeline li > div\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/u,
    );
  });
});
