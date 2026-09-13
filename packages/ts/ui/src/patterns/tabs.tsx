"use client";

import { useLayoutEffect, useRef, type KeyboardEvent } from "react";

export interface TabItem {
  readonly controls?: string;
  readonly count?: number;
  readonly id: string;
  readonly label: string;
  readonly tabId?: string;
}

export interface TabsProps {
  readonly activeId: string;
  readonly ariaLabel: string;
  readonly direction?: "ltr" | "rtl";
  readonly items: readonly TabItem[];
  readonly onChange: (id: string) => void;
  readonly orientation?: "horizontal" | "vertical";
  readonly className?: string;
}

export function Tabs({
  activeId,
  ariaLabel,
  direction = "ltr",
  items,
  onChange,
  orientation = "horizontal",
  className = "",
}: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (orientation !== "horizontal" || list === null) return;
    const active = list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (active === null) return;
    const reveal = () => {
      if (typeof list.scrollBy !== "function") return;
      const viewport = list.getBoundingClientRect();
      const selected = active.getBoundingClientRect();
      const left = viewport.left + list.clientLeft;
      const right = left + list.clientWidth;
      const delta =
        selected.left < left
          ? selected.left - left
          : selected.right > right
            ? selected.right - right
            : 0;
      // Physical geometry works for either RTL scrollLeft convention. Only
      // this strip moves; focusing/revealing a tab must not jump the document.
      if (delta !== 0) list.scrollBy({ left: delta, top: 0, behavior: "auto" });
    };
    reveal();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(reveal);
    observer?.observe(list);
    observer?.observe(active);
    return () => observer?.disconnect();
  }, [activeId, direction, orientation]);

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextKey =
      orientation === "vertical"
        ? "ArrowDown"
        : direction === "rtl"
          ? "ArrowLeft"
          : "ArrowRight";
    const previousKey =
      orientation === "vertical"
        ? "ArrowUp"
        : direction === "rtl"
          ? "ArrowRight"
          : "ArrowLeft";
    if (![previousKey, nextKey, "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const last = items.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === nextKey
            ? (index + 1) % items.length
            : (index + last) % items.length;
    const item = items[next];
    if (item === undefined) return;
    onChange(item.id);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>("[role=tab]")
      .item(next)
      .focus({ preventScroll: true });
  }

  return (
    <div
      aria-label={ariaLabel}
      aria-orientation={orientation}
      className={`or-tabs ${className}`.trim()}
      ref={listRef}
      role="tablist"
    >
      {items.map((item, index) => (
        <button
          aria-controls={item.controls}
          aria-selected={item.id === activeId}
          className="or-tabs__tab"
          id={item.tabId}
          key={item.id}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => move(event, index)}
          role="tab"
          tabIndex={item.id === activeId ? 0 : -1}
          type="button"
        >
          <span>{item.label}</span>
          {item.count === undefined ? null : <small>{item.count}</small>}
        </button>
      ))}
    </div>
  );
}
