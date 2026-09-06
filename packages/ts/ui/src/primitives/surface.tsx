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
}

export function Surface({
  as: Element = "section",
  children,
  className = "",
  level = "base",
  ...props
}: SurfaceProps) {
  return (
    <Element
      className={`or-surface or-surface--${level} ${className}`.trim()}
      {...props}
    >
      {children}
    </Element>
  );
}
