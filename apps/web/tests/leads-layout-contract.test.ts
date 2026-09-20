// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../src/features/leads/leads-workspace.module.css", import.meta.url),
  "utf8",
);

describe("Leads responsive layout alongside the workspace sidebar", () => {
  it("switches filters and table rows together before a tablet desktop sidebar clips them", () => {
    const query = /@media \(max-width: (\d+)rem\)/u.exec(css);
    const breakpoint = query?.index ?? -1;
    expect(breakpoint).toBeGreaterThan(0);
    const compact = css.slice(
      breakpoint,
      css.indexOf("@media (max-width: 35rem)"),
    );
    expect(compact).toMatch(
      /\.filters\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u,
    );
    expect(compact).toMatch(
      /\.directory table,\s*\.directory tbody\s*\{[^}]*min-width: 0 !important;/u,
    );
    expect(compact).toMatch(/\.directory tr\s*\{[^}]*display: grid;/u);
    expect(compact).toMatch(/\.cellLabel\s*\{[^}]*display: block;/u);
    // 1024/1280px viewports retain the desktop shell sidebar. At 1440px the
    // original six-column directory and four-column filter row still fit.
    const compactWidth = Number(query?.[1]) * 16;
    expect(compactWidth).toBeGreaterThanOrEqual(1280);
    expect(compactWidth).toBeLessThan(1440);
  });

  it("retains the phone-specific single-column controls and cards", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 35rem)"));
    expect(phone).toMatch(
      /\.filters,\s*\.secondaryFilters,\s*\.directory tr\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/u,
    );
  });
});
