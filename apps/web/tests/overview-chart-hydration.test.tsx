import type * as Motion from "motion/react";
import { describe, expect, it, vi } from "vitest";
import { MessageActivityChart } from "../src/features/overview";
import { renderMarkup } from "./localized";

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof Motion>()),
  useReducedMotion: () => preference.reduced,
}));

describe("overview chart hydration", () => {
  it("keeps initial SVG markup identical for server and reduced-motion browser", () => {
    const days = [
      { day: "2026-10-03", inbound: 3, outbound: 2, delivered: 1, failed: 0 },
    ];
    preference.reduced = false;
    const server = renderMarkup(<MessageActivityChart days={days} />);
    preference.reduced = true;
    const reduced = renderMarkup(<MessageActivityChart days={days} />);
    expect(reduced).toBe(server);
    expect(reduced).toContain("overview-chart-line");
    expect(reduced).toContain("stroke-dasharray");
  });
});
