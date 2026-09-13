import type { TextareaHTMLAttributes } from "react";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly error?: string;
  readonly hint?: string;
  readonly id: string;
  readonly label: string;
}

export function Textarea({
  "aria-describedby": describedBy,
  "aria-errormessage": externalErrorMessage,
  "aria-invalid": invalid,
  className = "",
  error,
  hint,
  id,
  label,
  ...props
}: TextareaProps) {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const references = [describedBy, hintId, errorId].filter(
    (value): value is string => Boolean(value),
  );
  const errorMessageIds = [externalErrorMessage, errorId].filter(
    (value): value is string => Boolean(value),
  );
  return (
    <div className="or-field">
      <label className="or-field__label" htmlFor={id}>
        {label}
      </label>
      <textarea
        {...props}
        aria-describedby={references.length ? references.join(" ") : undefined}
        aria-errormessage={
          errorMessageIds.length ? errorMessageIds.join(" ") : undefined
        }
        aria-invalid={error === undefined ? invalid : true}
        className={`or-textarea ${className}`.trim()}
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
