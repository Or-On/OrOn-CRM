import type { InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
}

export function Input({ hint, id, label, ...props }: InputProps) {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <label className="or-field" htmlFor={id}>
      <span className="or-field__label">{label}</span>
      <input
        aria-describedby={hintId}
        className="or-input"
        id={id}
        {...props}
      />
      {hint === undefined ? null : (
        <span className="or-field__hint" id={hintId}>
          {hint}
        </span>
      )}
    </label>
  );
}
