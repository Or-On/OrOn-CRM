"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface PopoverProps {
  readonly label: string;
  readonly trigger: ReactNode;
  readonly children:
    ReactNode | ((controls: { close: () => void }) => ReactNode);
  readonly align?: "start" | "end";
  readonly className?: string;
  readonly triggerClassName?: string;
  readonly contentClassName?: string;
  readonly disabled?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly role?: "dialog" | "menu";
  readonly triggerId?: string;
}

const focusable =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

function isNativePickerOpen(target: EventTarget) {
  const select = target instanceof Element ? target.closest("select") : null;
  try {
    return select?.matches(":open") ?? false;
  } catch {
    // Older engines without :open keep their platform picker key handling.
    return false;
  }
}

/** Shared collision handling for an anchored nonmodal top-layer surface. */
export function popoverPosition(
  anchor: { left: number; right: number; top: number; bottom: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  align: "start" | "end",
  rtl: boolean,
) {
  const gutter = 12;
  const gap = 8;
  const width = Math.min(panel.width, viewport.width - gutter * 2);
  const below = viewport.height - anchor.bottom - gap - gutter;
  const above = anchor.top - gap - gutter;
  const opensAbove = below < Math.min(panel.height, 200) && above > below;
  const maxHeight = Math.max(44, opensAbove ? above : below);
  const alignRight = (align === "end") !== rtl;
  return {
    left: Math.max(
      gutter,
      Math.min(
        alignRight ? anchor.right - width : anchor.left,
        viewport.width - width - gutter,
      ),
    ),
    top: Math.max(
      gutter,
      opensAbove
        ? anchor.top - Math.min(panel.height, maxHeight) - gap
        : anchor.bottom + gap,
    ),
    maxHeight,
    origin: opensAbove ? "bottom" : "top",
  };
}

/**
 * Nonmodal menus that contain actual form fields/actions, not menuitem fakes.
 * Native top-layer placement keeps it visible inside an overflowed rail/dialog;
 * the DOM stays beside its trigger so modal focus scopes include its controls.
 */
export function Popover({
  label,
  trigger,
  children,
  align = "start",
  className = "",
  triggerClassName = "",
  contentClassName = "",
  disabled = false,
  open,
  onOpenChange,
  role = "dialog",
  triggerId,
}: PopoverProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const restoreFocus = useRef(false);
  const nativeOpen = useRef(false);
  const typeahead = useRef({ text: "", at: 0 });

  const change = useCallback(
    (next: boolean, restore = false) => {
      restoreFocus.current = restore;
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, open],
  );
  const close = useCallback(() => change(false, true), [change]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = triggerRef.current;
    if (panel === null || anchor === null) return;
    if (!isOpen) {
      if (nativeOpen.current) {
        panel.hidePopover();
        nativeOpen.current = false;
      }
      if (restoreFocus.current && anchor.isConnected) anchor.focus();
      return;
    }
    if (typeof panel.showPopover === "function") {
      panel.showPopover();
      nativeOpen.current = true;
    } else {
      // Older browsers keep the same nonmodal keyboard/focus behavior without
      // a top-layer API; removing the attribute avoids an unsupported UA rule.
      panel.removeAttribute("popover");
    }
    const reposition = () => {
      const position = popoverPosition(
        anchor.getBoundingClientRect(),
        panel.getBoundingClientRect(),
        {
          width: document.documentElement.clientWidth,
          height: window.innerHeight,
        },
        align,
        getComputedStyle(anchor).direction === "rtl",
      );
      panel.style.left = `${String(position.left)}px`;
      panel.style.top = `${String(position.top)}px`;
      panel.style.maxHeight = `${String(position.maxHeight)}px`;
      panel.style.transformOrigin = `${position.origin} center`;
    };
    reposition();
    const initial =
      panel.querySelector<HTMLElement>("[data-popover-initial-focus]") ??
      [...panel.querySelectorAll<HTMLElement>(focusable)].find(
        (element) => element.getClientRects().length > 0,
      );
    (initial ?? panel).focus();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(reposition);
    observer?.observe(anchor);
    observer?.observe(panel);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      observer?.disconnect();
    };
  }, [isOpen, align]);

  useEffect(() => {
    if (!isOpen) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panelRef.current?.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      )
        change(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [change, isOpen]);

  function dismiss(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && isOpen) {
      if (isNativePickerOpen(event.target)) {
        // The native picker is the innermost surface. Let its default Escape
        // close it without also dismissing this popover or the enclosing rail.
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!isOpen || role !== "menu") return;
    const items = [
      ...(panelRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled):not([aria-disabled="true"]), [role="menuitemcheckbox"]:not(:disabled):not([aria-disabled="true"]), [role="menuitemradio"]:not(:disabled):not([aria-disabled="true"])',
      ) ?? []),
    ];
    if (items.length === 0) return;
    const index = items.findIndex((item) => item === document.activeElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    if (event.key === "ArrowUp")
      next = items[(index - 1 + items.length) % items.length];
    if (event.key === "Home") next = items[0];
    if (event.key === "End") next = items.at(-1);
    if (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const now = Date.now();
      typeahead.current = {
        text:
          now - typeahead.current.at > 500
            ? event.key
            : typeahead.current.text + event.key,
        at: now,
      };
      next = items.find((item) =>
        item.textContent
          .trim()
          .toLocaleLowerCase()
          .startsWith(typeahead.current.text.toLocaleLowerCase()),
      );
    }
    if (next !== undefined) {
      event.preventDefault();
      next.focus();
    }
  }

  return (
    <div className={`or-popover ${className}`.trim()} onKeyDown={dismiss}>
      <button
        aria-controls={id}
        aria-expanded={isOpen}
        aria-haspopup={role}
        aria-label={label}
        className={`or-popover__trigger ${triggerClassName}`.trim()}
        disabled={disabled}
        id={triggerId}
        onClick={() => change(!isOpen, isOpen)}
        ref={triggerRef}
        type="button"
      >
        {trigger}
      </button>
      <div
        aria-label={label}
        className={`or-popover__panel ${contentClassName}`.trim()}
        hidden={!isOpen}
        id={id}
        popover="manual"
        ref={panelRef}
        role={role}
        tabIndex={-1}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !event.currentTarget.contains(event.relatedTarget) &&
            !triggerRef.current?.contains(event.relatedTarget)
          )
            change(false);
        }}
      >
        {typeof children === "function" ? children({ close }) : children}
      </div>
    </div>
  );
}
