import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnimatedNumber } from "../src/primitives/animated-number";

let frames: FrameRequestCallback[];
let reduced = false;
beforeEach(() => {
  frames = [];
  reduced = false;
  vi.spyOn(performance, "now").mockReturnValue(0);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    frames.push(callback),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", () => ({
    matches: reduced,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("truthful animated numbers", () => {
  it("renders the full initial value without a fabricated loading count", () => {
    const { container } = render(<AnimatedNumber value={1234} locale="en" />);
    expect(container.querySelector(".or-visually-hidden")?.textContent).toBe(
      "1,234",
    );
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "1,234",
    );
    expect(frames).toHaveLength(0);
  });
  it("can animate decorative digits on mount while announcing the exact value", () => {
    const { container } = render(
      <AnimatedNumber animateOnMount value={120} locale="en" />,
    );
    expect(container.querySelector(".or-visually-hidden")?.textContent).toBe(
      "120",
    );
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "0",
    );
    expect(frames).toHaveLength(1);
    act(() => frames.shift()?.(320));
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "120",
    );
  });
  it("announces the exact updated value while only decorative digits interpolate", () => {
    const { container, rerender } = render(
      <AnimatedNumber value={0} locale="en" />,
    );
    rerender(<AnimatedNumber value={200} locale="en" />);
    expect(container.querySelector(".or-visually-hidden")?.textContent).toBe(
      "200",
    );
    act(() => frames.shift()?.(160));
    const middle = Number(
      container.querySelector('[aria-hidden="true"]')?.textContent,
    );
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(200);
    act(() => frames.shift()?.(320));
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "200",
    );
  });
  it("updates immediately with reduced motion and preserves numeric formatting", () => {
    reduced = true;
    const { container, rerender } = render(
      <AnimatedNumber value={1.5} locale="he" maximumFractionDigits={1} />,
    );
    rerender(
      <AnimatedNumber value={2.7} locale="he" maximumFractionDigits={1} />,
    );
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      new Intl.NumberFormat("he", { maximumFractionDigits: 1 }).format(2.7),
    );
    expect(frames).toHaveLength(0);
  });
});
