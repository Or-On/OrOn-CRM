import type { ComponentPropsWithRef } from "react";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  readonly variant?: "primary" | "secondary" | "quiet";
}

export function Button({
  className = "",
  variant = "primary",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`or-button or-button--${variant} ${className}`.trim()}
      type={type}
      {...props}
    />
  );
}
