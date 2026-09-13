// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../src/app/workspace-premium.css", import.meta.url),
  "utf8",
);

describe("shared route feedback layout", () => {
  it("centers every route-state symbol and its feedback content", () => {
    expect(css).toMatch(
      /\.route-state :is\(\.route-state__symbol, \.route-state__icon\)\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/u,
    );
    expect(css).toMatch(
      /\.route-state \.or-feedback\s*\{[^}]*justify-items:\s*center;[^}]*text-align:\s*center;/u,
    );
  });

  it("keeps route actions full-width only on compact screens", () => {
    const compact = css.slice(css.indexOf("@media (max-width: 40rem)"));
    expect(compact).toMatch(
      /\.route-state \.or-feedback > :is\(a, button\)\s*\{[^}]*inline-size:\s*100%;/u,
    );
  });
});
