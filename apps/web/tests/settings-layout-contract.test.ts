// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../src/app/workspace-details.css", import.meta.url),
  "utf8",
);
const replicaCss = readFileSync(
  new URL("../src/app/studio-replica.css", import.meta.url),
  "utf8",
);

function rule(selector: string, source = css) {
  const start = source.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start) + 1);
}

describe("Settings responsive header and invitation layout", () => {
  it("presents uploaded organization marks without a generic avatar tile", () => {
    expect(replicaCss).toMatch(
      /\.identity-image-editor\[data-variant="organization"\]\s+\.identity-image-editor__preview\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*box-shadow:\s*none;/u,
    );
    expect(replicaCss).toMatch(
      /\.identity-image-editor\[data-variant="organization"\][\s\S]*\.identity-image__media\s*\{[^}]*padding:\s*0;[^}]*object-fit:\s*contain;[^}]*filter:\s*none;/u,
    );
    expect(css).toMatch(
      /\.settings-workspace-identity\s+\.settings-workspace-identity__logo\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*box-shadow:\s*none;/u,
    );
  });

  it("wraps header content before shrinking action labels at intermediate widths", () => {
    expect(rule(".settings-index-surface > .or-section-header")).toContain(
      "flex-wrap: wrap;",
    );
    expect(
      rule(".settings-index-surface > .or-section-header > div:first-child"),
    ).toContain("flex: 1 1 16rem;");
    const action = rule(".settings-index-surface .or-section-header__action");
    expect(action).toContain("flex: 0 0 auto;");
    expect(action).toContain("min-inline-size: max-content;");
    const button = rule(
      ".settings-index-surface .or-section-header__action > .or-button",
    );
    expect(button).toContain("white-space: nowrap;");
    expect(button).toContain("flex-shrink: 0;");
    expect(button).not.toMatch(/font-size|overflow:\s*hidden/u);
  });

  it("gives compact invitation emails their own row without hiding role or expiry", () => {
    const compact = css.slice(css.indexOf("@media (max-width: 46rem)"));
    expect(rule(".settings-invitation-list article", compact)).toContain(
      "grid-template-columns: minmax(0, 1fr) auto;",
    );
    expect(
      rule(".settings-invitation-list article > span:first-child", compact),
    ).toContain("grid-column: 1 / -1;");
    expect(
      rule(".settings-invitation-list article > .or-badge", compact),
    ).toContain("justify-self: start;");
  });
});
