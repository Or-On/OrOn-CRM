import type { ReactNode } from "react";

import { Surface } from "./surface";

interface FeedbackProps {
  readonly action?: ReactNode;
  readonly description: string;
  readonly title: string;
}

export function EmptyState({ action, description, title }: FeedbackProps) {
  return (
    <Surface aria-labelledby="empty-state-title" className="or-feedback">
      <p className="or-eyebrow">Nothing here yet</p>
      <h2 id="empty-state-title">{title}</h2>
      <p>{description}</p>
      {action}
    </Surface>
  );
}

export function ErrorState({ action, description, title }: FeedbackProps) {
  return (
    <Surface
      aria-labelledby="error-state-title"
      className="or-feedback"
      role="alert"
    >
      <p className="or-eyebrow">Needs attention</p>
      <h2 id="error-state-title">{title}</h2>
      <p>{description}</p>
      {action}
    </Surface>
  );
}
