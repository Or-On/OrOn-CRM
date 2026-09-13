"use client";

import { flushSync } from "react-dom";

type ResolvedTheme = "dark" | "light";

interface ThemeTransitionOptions {
  readonly currentResolvedTheme: string | undefined;
  readonly origin: HTMLElement;
  readonly setTheme: (theme: string) => void;
  readonly systemTheme?: string | undefined;
  readonly targetTheme: string;
}

const themeTransitionDuration = 420;
const themeTransitionEasing = "cubic-bezier(0.22, 1, 0.36, 1)";

function resolvedTheme(
  theme: string,
  systemTheme: string | undefined,
): ResolvedTheme | undefined {
  if (theme === "dark" || theme === "light") return theme;
  if (theme !== "system") return undefined;
  if (systemTheme === "dark" || systemTheme === "light") return systemTheme;

  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Reveals the selected palette from the control that initiated the change.
 * Browsers without same-document view transitions keep the reference
 * dashboard's flash-free, immediate theme switch.
 */
export function applyThemeTransition({
  currentResolvedTheme,
  origin,
  setTheme,
  systemTheme,
  targetTheme,
}: ThemeTransitionOptions): void {
  const targetResolvedTheme = resolvedTheme(targetTheme, systemTheme);
  let themeApplied = false;
  const applyTheme = () => {
    if (themeApplied) return;
    themeApplied = true;
    flushSync(() => setTheme(targetTheme));
  };

  if (
    targetResolvedTheme === undefined ||
    targetResolvedTheme === currentResolvedTheme ||
    prefersReducedMotion() ||
    typeof document.startViewTransition !== "function" ||
    typeof document.documentElement.animate !== "function"
  ) {
    applyTheme();
    return;
  }

  const bounds = origin.getBoundingClientRect();
  const x = bounds.left + bounds.width / 2;
  const y = bounds.top + bounds.height / 2;
  const endRadius = Math.ceil(
    Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    ),
  );
  const originPosition = `${String(x)}px ${String(y)}px`;

  try {
    const transition = document.startViewTransition(applyTheme);

    void transition.ready
      .then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${originPosition})`,
              `circle(${String(endRadius)}px at ${originPosition})`,
            ],
          },
          {
            duration: themeTransitionDuration,
            easing: themeTransitionEasing,
            fill: "both",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => undefined);
    void transition.finished.catch(() => undefined);
  } catch {
    applyTheme();
  }
}
