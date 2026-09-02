import { useId, type ReactNode } from "react";

import { Surface } from "./surface";

interface FeedbackProps {
  readonly action?: ReactNode;
  readonly description: string;
  readonly title: string;
}

export function EmptyState({ action, description, title }: FeedbackProps) {
  const titleId = useId();
  return (
    <Surface aria-labelledby={titleId} className="or-feedback">
      <p className="or-eyebrow">Nothing here yet</p>
      <h2 id={titleId}>{title}</h2>
      <p>{description}</p>
      {action}
    </Surface>
  );
}

export function ErrorState({ action, description, title }: FeedbackProps) {
  const titleId = useId();
  return (
    <Surface aria-labelledby={titleId} className="or-feedback" role="alert">
      <p className="or-eyebrow">Needs attention</p>
      <h2 id={titleId}>{title}</h2>
      <p>{description}</p>
      {action}
    </Surface>
  );
}
