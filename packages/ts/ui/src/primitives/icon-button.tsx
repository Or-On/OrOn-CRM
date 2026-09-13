import type { ReactNode } from "react";

import { Button, type ButtonProps } from "./button";

export interface IconButtonProps extends Omit<ButtonProps, "aria-label"> {
  readonly label: string;
  readonly children: ReactNode;
}

export function IconButton({
  children,
  className = "",
  label,
  size = "small",
  title,
  variant = "quiet",
  ...props
}: IconButtonProps) {
  return (
    <Button
      aria-label={label}
      className={`or-icon-button ${className}`.trim()}
      size={size}
      title={title ?? label}
      variant={variant}
      {...props}
    >
      {children}
    </Button>
  );
}
