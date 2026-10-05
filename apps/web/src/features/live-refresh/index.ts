"use client";

import { useEffect, useRef } from "react";

/** Refresh visible lists without interrupting editing or overlapping requests. */
export function useVisibleRefresh(
  refresh: () => void | Promise<void>,
  enabled = true,
) {
  const current = useRef(refresh);
  useEffect(() => {
    current.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (!enabled) return;
    let running = false;
    let disposed = false;
    async function tick() {
      if (
        disposed ||
        running ||
        document.visibilityState !== "visible" ||
        document.querySelector(
          'dialog[open], [role="dialog"][aria-modal="true"]',
        ) ||
        document.activeElement?.closest(
          'input, textarea, select, [contenteditable="true"], [role="textbox"]',
        )
      )
        return;
      running = true;
      try {
        await current.current();
      } catch {
        // Preserve the last successful view; the next visible tick can retry.
      } finally {
        running = false;
      }
    }
    const poll = () => {
      void tick();
    };
    const timer = window.setInterval(poll, 5000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [enabled]);
}
