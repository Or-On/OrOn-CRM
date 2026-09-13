import type { InputHTMLAttributes, ReactNode } from "react";

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type"
> {
  readonly children: ReactNode;
}

export function Checkbox({
  children,
  className = "",
  ...props
}: CheckboxProps) {
  return (
    <label className={`or-checkbox ${className}`.trim()}>
      <input {...props} type="checkbox" />
      <span aria-hidden="true" className="or-checkbox__control" />
      <span>{children}</span>
    </label>
  );
}
