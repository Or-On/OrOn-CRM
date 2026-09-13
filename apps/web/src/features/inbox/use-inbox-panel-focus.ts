"use client";

import { useEffect, type RefObject } from "react";

/** Keeps responsive Inbox panels mounted without leaving hidden/background controls active. */
export function useInboxPanelFocus({
  open,
  modal,
  panelRef,
  triggerRef,
  onClose,
}: {
  readonly open: boolean;
  readonly modal: boolean;
  readonly panelRef: RefObject<HTMLElement | null>;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}) {
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const trigger = triggerRef.current;
    const focusable = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ).filter(
        (element) =>
          !element.closest("[inert], [hidden]") &&
          (typeof element.checkVisibility !== "function" ||
            element.checkVisibility()),
      );
    const focusFirst = () => (focusable()[0] ?? panel).focus();
    const inertSiblings: { element: HTMLElement; value: string | null }[] = [];
    const previousOverflow = document.body.style.overflow;
    if (modal) {
      // Include the shell/header, not just the adjacent list and thread.
      let branch: HTMLElement = panel;
      while (branch.parentElement) {
        for (const sibling of branch.parentElement.children) {
          if (
            sibling !== branch &&
            sibling instanceof HTMLElement &&
            !sibling.hasAttribute("data-inbox-overlay-dismiss")
          ) {
            inertSiblings.push({
              element: sibling,
              value: sibling.getAttribute("inert"),
            });
            sibling.setAttribute("inert", "");
          }
        }
        branch = branch.parentElement;
        if (branch === document.body) break;
      }
      document.body.style.overflow = "hidden";
    }
    focusFirst();
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        (modal || panel.contains(event.target as Node))
      ) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
      if (!modal || event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0] ?? panel;
      const last = elements.at(-1) ?? panel;
      if (
        !panel.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (modal && !panel.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      for (const { element, value } of inertSiblings) {
        if (value === null) element.removeAttribute("inert");
        else element.setAttribute("inert", value);
      }
      if (modal) document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [modal, onClose, open, panelRef, triggerRef]);
}
