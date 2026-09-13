// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("shared visual contracts", () => {
  it("reserves an explicit application layer in the shared cascade order", () => {
    expect(css).toContain(
      "@layer or-tokens, or-base, or-components, or-app, or-utilities;",
    );
  });

  it("normalizes direct control icons to a shared square geometry", () => {
    expect(css).toContain("--or-control-icon-size: 1rem;");
    expect(css).toContain("inline-size: var(--or-control-icon-size, 1rem);");
    expect(css).toContain("block-size: var(--or-control-icon-size, 1rem);");
  });

  it("keeps surface treatments and contextual feedback centrally defined", () => {
    for (const selector of [
      ".or-surface--outlined",
      ".or-surface--plain",
      ".or-surface--inset",
      ".or-inline-feedback--critical",
      ".or-confirm-dialog__actions",
    ]) {
      expect(css).toContain(selector);
    }
  });

  it("defines compact shell proportions in the shared token layer", () => {
    expect(css).toContain("--or-rail-width: 4.5rem;");
    expect(css).toContain("--or-sidebar-expanded: 16.5rem;");
    expect(css).toContain("--or-header-height: 4rem;");
  });

  it("keeps status tone colors after the equal-specificity neutral base", () => {
    const base = css.indexOf(".or-status {");
    expect(base).toBeGreaterThanOrEqual(0);
    for (const tone of ["positive", "warning", "critical", "info"]) {
      const variant = css.indexOf(`.or-status--${tone} {`);
      expect(
        variant,
        `${tone} must override the neutral status color`,
      ).toBeGreaterThan(base);
      const declarations = css.slice(variant, css.indexOf("}", variant));
      expect(declarations).toContain(`color: var(--or-${tone});`);
    }
    expect(css).toMatch(
      /\.or-badge__marker,\s*\.or-status__marker\s*\{[^}]*background: currentcolor;/u,
    );
  });
});
