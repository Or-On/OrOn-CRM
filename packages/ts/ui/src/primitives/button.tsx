import type { ComponentPropsWithRef } from "react";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  readonly busy?: boolean;
  readonly size?: "small" | "medium";
  readonly variant?: "primary" | "secondary" | "quiet" | "danger";
}

export function Button({
  busy = false,
  className = "",
  disabled,
  size = "medium",
  variant = "primary",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      aria-busy={busy || undefined}
      className={`or-button or-button--${variant} or-button--${size} ${className}`.trim()}
      disabled={Boolean(disabled) || busy}
      type={type}
      {...props}
    />
  );
}
