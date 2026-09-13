import type { ReactNode, Ref, SelectHTMLAttributes } from "react";

export interface SelectInputProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly ref?: Ref<HTMLSelectElement>;
}

/**
 * A real select retains platform keyboard, validation, reset and form behavior.
 * The shared CSS enhances its anchored top-layer picker where base-select is
 * supported; other browsers keep their accessible platform picker.
 */
export function SelectInput({ className = "", ...props }: SelectInputProps) {
  return <select {...props} className={`or-select ${className}`.trim()} />;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly children: ReactNode;
  readonly hint?: string;
  readonly error?: string;
  readonly id: string;
  readonly label: string;
}

export function Select({
  children,
  className = "",
  hint,
  error,
  id,
  label,
  ...props
}: SelectProps) {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy =
    [
      ...new Set(
        [props["aria-describedby"], hintId, errorId]
          .filter(Boolean)
          .join(" ")
          .split(/\s+/),
      ),
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="or-field">
      <label className="or-field__label" htmlFor={id}>
        {label}
      </label>
      <SelectInput
        {...props}
        aria-describedby={describedBy}
        aria-errormessage={errorId ?? props["aria-errormessage"]}
        aria-invalid={error === undefined ? props["aria-invalid"] : true}
        className={className}
        id={id}
      >
        {children}
      </SelectInput>
      {hint === undefined ? null : (
        <span className="or-field__hint" id={hintId}>
          {hint}
        </span>
      )}
      {error === undefined ? null : (
        <span className="or-field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
