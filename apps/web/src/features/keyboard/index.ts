"use client";

import { useEffect, useRef } from "react";

/** Recover focus lost when a pending mutation disables its controls. */
export function useMutationFocus(pending: boolean) {
  const remembered = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (pending) return;
    const target = remembered.current;
    remembered.current = null;
    if (
      target?.isConnected &&
      !target.matches(":disabled") &&
      document.activeElement === document.body
    )
      target.focus();
  }, [pending]);
  return (
    target: HTMLElement | null = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  ) => {
    remembered.current = target === document.body ? null : target;
  };
}
