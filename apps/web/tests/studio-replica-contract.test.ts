import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const css = readFileSync(resolve(root, "src/app/studio-replica.css"), "utf8");
const layout = readFileSync(resolve(root, "src/app/layout.tsx"), "utf8");
const shell = readFileSync(
  resolve(root, "src/features/shell/index.tsx"),
  "utf8",
);

describe("Studio Admin replica contract", () => {
  it("pins the reference shell geometry and typography", () => {
    expect(css).toContain("--or-sidebar-expanded: 17rem");
    expect(css).toContain("--or-rail-width: 3rem");
    expect(css).toContain("--or-header-height: 3rem");
    expect(css).toContain("--or-radius-md: 0.625rem");
    expect(layout).toContain("Geist_Mono");
    expect(layout).toContain('import "./studio-replica.css"');
    expect(shell).toContain("<BrandMark");
  });

  it("uses Studio neutral light and dark surfaces", () => {
    expect(css).toContain("--or-bg: oklch(1 0 0)");
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain("--or-bg: oklch(0.145 0 0)");
    expect(css).toContain("--or-border: oklch(1 0 0 / 10%)");
  });

  it("stretches dashboard cards to eliminate empty grid-row gaps", () => {
    expect(css).toMatch(
      /\.overview-command-grid\s*\{[^}]*align-items:\s*stretch;/su,
    );
  });

  it("keeps the phone Inbox navigator compact and restores every utility", () => {
    expect(css).toMatch(
      /@media\s*\(max-width:\s*47\.999rem\)[\s\S]*\.shell--inbox \.inbox-navigator\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/u,
    );
    expect(css).toMatch(
      /\.shell--inbox \.topbar-actions \.language-control\s*\{[^}]*display:\s*block;/u,
    );
    expect(css).toContain("--or-header-height: 6.25rem");
  });

  it("isolates the root theme reveal and keeps reduced motion instantaneous", () => {
    expect(css).toMatch(
      /::view-transition-old\(root\),\s*::view-transition-new\(root\)\s*\{[^}]*pointer-events:\s*none;[^}]*animation:\s*none;[^}]*mix-blend-mode:\s*normal;/su,
    );
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*::view-transition-old\(root\),\s*::view-transition-new\(root\)\s*\{[^}]*animation(?:-duration)?:\s*(?:none|0(?:\.\d+)?(?:ms|s))(?:\s*!important)?;/u,
    );
  });

  it("keeps login preference controls legible over the persistent dark panel", () => {
    expect(css).toMatch(
      /\.login-preferences \.or-select\s*\{[^}]*color:\s*oklch\(0\.985 0 0\);[^}]*background:\s*oklch\(0\.205 0 0 \/ 92%\);[^}]*color-scheme:\s*dark;/su,
    );
    expect(css).toMatch(
      /\.login-preferences \.or-select option\s*\{[^}]*color:\s*oklch\(0\.985 0 0\);[^}]*background:\s*oklch\(0\.205 0 0\);/su,
    );
    expect(css).toMatch(
      /\.login-preferences \.or-select::picker\(select\)\s*\{[^}]*color:\s*oklch\(0\.985 0 0\);[^}]*background:\s*oklch\(0\.205 0 0\);[^}]*color-scheme:\s*dark;/su,
    );
    expect(css).toMatch(
      /\.login-preferences \.or-select option:checked\s*\{[^}]*color:\s*oklch\(0\.985 0 0\);[^}]*background:\s*#0b315f;/su,
    );
  });

  it.each([
    ".contacts-workspace",
    ".inbox-workspace",
    ".pipeline-board",
    ".operation-index",
    ".voice-call-index",
    ".contact-record__profile",
    ".settings-form-surface",
    ".health-services",
    ".login-page",
    ".route-state",
  ])("covers the %s surface", (selector) => {
    expect(css).toContain(selector);
  });
});
