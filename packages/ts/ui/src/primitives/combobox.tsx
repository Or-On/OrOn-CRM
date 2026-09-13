"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Popover } from "./popover";
import { SelectInput } from "./select";

export interface ComboboxOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface ComboboxProps {
  readonly id: string;
  readonly label: string;
  readonly options: readonly ComboboxOption[];
  readonly searchLabel: string;
  readonly emptyLabel: string;
  readonly placeholder?: string;
  readonly name?: string;
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly disabled?: boolean;
  readonly required?: boolean;
}

/** Searchable entity selection; the hidden native control owns form semantics. */
export function Combobox({
  id,
  label,
  options,
  searchLabel,
  emptyLabel,
  placeholder,
  name,
  value,
  defaultValue,
  onValueChange,
  disabled = false,
  required = false,
}: ComboboxProps) {
  const listId = useId();
  const nativeRef = useRef<HTMLSelectElement>(null);
  const initialValue =
    defaultValue ?? options.find((option) => !option.disabled)?.value ?? "";
  const [internalValue, setInternalValue] = useState(initialValue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedValue = value ?? internalValue;
  const selected = options.find((option) => option.value === selectedValue);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = options.filter((option) =>
    `${option.label} ${option.description ?? ""}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
  const enabled = filtered.filter((option) => !option.disabled);
  const active = enabled[activeIndex] ?? enabled[0];
  const activeId =
    active === undefined
      ? undefined
      : `${listId}-${String(options.indexOf(active))}`;

  function choose(next: string) {
    if (value === undefined) setInternalValue(next);
    onValueChange?.(next);
  }

  useEffect(() => {
    const form = nativeRef.current?.form;
    if (!form) return;
    const reset = () => {
      if (value === undefined) setInternalValue(initialValue);
    };
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [initialValue, value]);

  useEffect(() => {
    if (!open || activeId === undefined) return;
    const option = document.getElementById(activeId);
    if (typeof option?.scrollIntoView === "function")
      option.scrollIntoView({ block: "nearest" });
  }, [activeId, open]);

  return (
    <div className="or-field or-combobox">
      <label className="or-field__label" htmlFor={id}>
        {label}
      </label>
      <SelectInput
        aria-hidden="true"
        className="or-combobox__native"
        disabled={disabled}
        name={name}
        onChange={(event) => choose(event.currentTarget.value)}
        onInvalid={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
        ref={nativeRef}
        required={required}
        tabIndex={-1}
        value={selectedValue}
      >
        {options.some((option) => option.value === "") ? null : (
          <option value="">{placeholder ?? label}</option>
        )}
        {options.map((option) => (
          <option
            disabled={option.disabled}
            key={option.value}
            value={option.value}
          >
            {option.label}
          </option>
        ))}
      </SelectInput>
      <Popover
        label={label}
        triggerId={id}
        triggerClassName="or-select or-combobox__trigger"
        contentClassName="or-combobox__panel"
        disabled={disabled}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setQuery("");
          setActiveIndex(0);
        }}
        trigger={
          <>
            <span>{selected?.label ?? placeholder ?? label}</span>
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </>
        }
      >
        {({ close }) => (
          <>
            <input
              aria-activedescendant={activeId}
              aria-autocomplete="list"
              aria-controls={listId}
              aria-expanded="true"
              aria-label={searchLabel}
              autoComplete="off"
              className="or-input or-combobox__search"
              data-popover-initial-focus
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "ArrowDown" ||
                  event.key === "ArrowUp" ||
                  event.key === "Home" ||
                  event.key === "End"
                ) {
                  event.preventDefault();
                  const last = enabled.length - 1;
                  setActiveIndex(
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? last
                        : enabled.length === 0
                          ? 0
                          : (activeIndex +
                              (event.key === "ArrowDown" ? 1 : last)) %
                            enabled.length,
                  );
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (active !== undefined) {
                    choose(active.value);
                    close();
                  }
                }
              }}
              placeholder={searchLabel}
              role="combobox"
              type="search"
              value={query}
            />
            <div
              aria-label={label}
              className="or-combobox__options"
              id={listId}
              role="listbox"
            >
              {filtered.map((option) => (
                <div
                  aria-disabled={option.disabled ?? false}
                  aria-selected={option.value === selectedValue}
                  className="or-combobox__option"
                  data-active={option === active}
                  id={`${listId}-${String(options.indexOf(option))}`}
                  key={option.value}
                  onClick={() => {
                    if (!option.disabled) {
                      choose(option.value);
                      close();
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !option.disabled) {
                      choose(option.value);
                      close();
                    }
                  }}
                  role="option"
                  tabIndex={-1}
                >
                  <span>
                    <strong>{option.label}</strong>
                    {option.description === undefined ? null : (
                      <small>{option.description}</small>
                    )}
                  </span>
                  {option.value === selectedValue ? (
                    <svg
                      aria-hidden="true"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                  ) : null}
                </div>
              ))}
            </div>
            {filtered.length === 0 ? (
              <p className="or-combobox__empty" role="status">
                {emptyLabel}
              </p>
            ) : null}
          </>
        )}
      </Popover>
    </div>
  );
}
