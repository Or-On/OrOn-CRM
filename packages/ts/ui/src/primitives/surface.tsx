import type { HTMLAttributes, ReactNode } from "react";

export interface SurfaceProps extends HTMLAttributes<HTMLElement> {
  readonly children: ReactNode;
  readonly level?: "base" | "raised" | "floating";
}

export function Surface({
  children,
  className = "",
  level = "base",
  ...props
}: SurfaceProps) {
  return (
    <section
      className={`or-surface or-surface--${level} ${className}`.trim()}
      {...props}
    >
      {children}
    </section>
  );
}
