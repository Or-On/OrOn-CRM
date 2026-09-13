import type { HTMLAttributes, ReactNode } from "react";

export type SurfaceElement =
  | "article"
  | "aside"
  | "div"
  | "footer"
  | "header"
  | "main"
  | "nav"
  | "section";

export interface SurfaceProps extends HTMLAttributes<HTMLElement> {
  readonly as?: SurfaceElement;
  readonly children: ReactNode;
  readonly level?: "base" | "raised" | "floating";
  readonly variant?: "outlined" | "plain" | "inset";
}

export function Surface({
  as: Element = "section",
  children,
  className = "",
  level = "base",
  variant = "outlined",
  ...props
}: SurfaceProps) {
  return (
    <Element
      className={`or-surface or-surface--${level} or-surface--${variant} ${className}`.trim()}
      {...props}
    >
      {children}
    </Element>
  );
}
