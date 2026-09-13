// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyThemeTransition } from "../src/i18n/theme-transition";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function mediaQueryList(query: string, reducedMotion = false) {
  return {
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    matches: reducedMotion && query === REDUCED_MOTION_QUERY,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  } satisfies MediaQueryList;
}

function installMatchMedia(reducedMotion = false) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => mediaQueryList(query, reducedMotion)),
  );
}

function installRootAnimation() {
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  Object.defineProperty(document.documentElement, "animate", {
    configurable: true,
    value: animate,
  });
  return animate;
}

function installViewTransition(ready: Promise<void> = Promise.resolve()) {
  const skipTransition = vi.fn();
  const startViewTransition = vi.fn(
    (
      callbackOptions?:
        StartViewTransitionOptions | ViewTransitionUpdateCallback,
    ) => {
      const update =
        typeof callbackOptions === "function"
          ? callbackOptions
          : callbackOptions?.update;
      const updateCallbackDone = Promise.resolve(update?.());
      return {
        finished: updateCallbackDone,
        ready,
        skipTransition,
        types: new Set<string>(),
        updateCallbackDone,
      };
    },
  );
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: startViewTransition,
  });
  return { skipTransition, startViewTransition };
}

function originElement() {
  const origin = document.createElement("button");
  vi.spyOn(origin, "getBoundingClientRect").mockReturnValue({
    bottom: 60,
    height: 40,
    left: 80,
    right: 120,
    top: 20,
    width: 40,
    x: 80,
    y: 20,
    toJSON: () => ({}),
  });
  return origin;
}

const startViewTransitionDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "startViewTransition",
);
const animateDescriptor = Object.getOwnPropertyDescriptor(
  document.documentElement,
  "animate",
);

beforeEach(() => {
  installMatchMedia();
  vi.stubGlobal("innerWidth", 1_000);
  vi.stubGlobal("innerHeight", 800);
});

afterEach(() => {
  if (startViewTransitionDescriptor) {
    Object.defineProperty(
      document,
      "startViewTransition",
      startViewTransitionDescriptor,
    );
  } else {
    Reflect.deleteProperty(document, "startViewTransition");
  }
  if (animateDescriptor) {
    Object.defineProperty(
      document.documentElement,
      "animate",
      animateDescriptor,
    );
  } else {
    Reflect.deleteProperty(document.documentElement, "animate");
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme transition", () => {
  it("applies the theme once when the View Transition API is unavailable", () => {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: undefined,
    });
    const setTheme = vi.fn();

    applyThemeTransition({
      currentResolvedTheme: "dark",
      origin: originElement(),
      setTheme,
      targetTheme: "light",
    });

    expect(setTheme).toHaveBeenCalledOnce();
    expect(setTheme).toHaveBeenCalledWith("light");
  });

  it("bypasses snapshots and animation when reduced motion is requested", () => {
    installMatchMedia(true);
    const { startViewTransition } = installViewTransition();
    const animate = installRootAnimation();
    const setTheme = vi.fn();

    applyThemeTransition({
      currentResolvedTheme: "dark",
      origin: originElement(),
      setTheme,
      targetTheme: "light",
    });

    expect(setTheme).toHaveBeenCalledOnce();
    expect(setTheme).toHaveBeenCalledWith("light");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(animate).not.toHaveBeenCalled();
  });

  it("reveals the new palette from the control center and covers the viewport", async () => {
    const { startViewTransition } = installViewTransition();
    const animate = installRootAnimation();
    const setTheme = vi.fn();

    applyThemeTransition({
      currentResolvedTheme: "dark",
      origin: originElement(),
      setTheme,
      targetTheme: "light",
    });

    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(setTheme).toHaveBeenCalledOnce();
    expect(setTheme).toHaveBeenCalledWith("light");
    await vi.waitFor(() => expect(animate).toHaveBeenCalledOnce());

    const serializedAnimation = JSON.stringify(animate.mock.calls[0]);
    expect(serializedAnimation).toContain("::view-transition-new(root)");
    expect(serializedAnimation).toContain("circle(0px at 100px 40px)");
    const radii = [
      ...serializedAnimation.matchAll(/circle\(([\d.]+)px at 100px 40px\)/gu),
    ].map((match) => Number(match[1]));
    expect(Math.max(...radii)).toBeGreaterThanOrEqual(Math.hypot(900, 760));
  });

  it("persists system mode without a visual transition when its palette is unchanged", () => {
    const { startViewTransition } = installViewTransition();
    const animate = installRootAnimation();
    const setTheme = vi.fn();

    applyThemeTransition({
      currentResolvedTheme: "dark",
      origin: originElement(),
      setTheme,
      systemTheme: "dark",
      targetTheme: "system",
    });

    expect(setTheme).toHaveBeenCalledOnce();
    expect(setTheme).toHaveBeenCalledWith("system");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(animate).not.toHaveBeenCalled();
  });

  it("does not repeat the theme mutation when transition readiness fails", async () => {
    const ready = Promise.reject(new Error("snapshot failed"));
    void ready.catch(() => undefined);
    installViewTransition(ready);
    const animate = installRootAnimation();
    const setTheme = vi.fn();

    applyThemeTransition({
      currentResolvedTheme: "dark",
      origin: originElement(),
      setTheme,
      targetTheme: "light",
    });

    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledOnce());
    expect(setTheme).toHaveBeenCalledWith("light");
    expect(animate).not.toHaveBeenCalled();
  });
});
