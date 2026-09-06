import type { InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly error?: string;
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
}

function mergeIdReferences(
  ...references: readonly (string | undefined)[]
): string | undefined {
  const identifiers = references.flatMap(
    (reference) => reference?.split(/\s+/).filter(Boolean) ?? [],
  );

  return identifiers.length === 0
    ? undefined
    : [...new Set(identifiers)].join(" ");
}

export function Input({
  "aria-describedby": describedBy,
  "aria-errormessage": externalErrorMessage,
  "aria-invalid": invalid,
  className = "",
  error,
  hint,
  id,
  label,
  ...props
}: InputProps) {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const descriptionIds = mergeIdReferences(describedBy, hintId, errorId);
  const errorMessageIds = mergeIdReferences(externalErrorMessage, errorId);

  return (
    <div className="or-field">
      <label className="or-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        {...props}
        aria-describedby={descriptionIds}
        aria-errormessage={errorMessageIds}
        aria-invalid={error === undefined ? invalid : true}
        className={`or-input ${className}`.trim()}
        id={id}
      />
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
