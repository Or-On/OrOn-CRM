import type { ReactNode } from "react";

/**
 * Stable route container. Route content is visible as soon as Next.js commits it;
 * navigation feedback belongs to the link/loading state, not a blocking reveal.
 */
export function PageTransition({
  children,
}: {
  readonly children: ReactNode;
  readonly transitionKey: string;
}) {
  return <div className="or-page-transition">{children}</div>;
}
