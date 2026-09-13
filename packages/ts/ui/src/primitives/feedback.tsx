import { useId, type ReactNode } from "react";

import { Surface } from "./surface";

interface FeedbackProps {
  readonly headingLevel?: 1 | 2;
  readonly action?: ReactNode;
  readonly description: string;
  readonly title: string;
}

export type InlineFeedbackTone = "info" | "positive" | "warning" | "critical";

export interface InlineFeedbackProps {
  readonly action?: ReactNode;
  readonly className?: string;
  readonly description: ReactNode;
  readonly title?: ReactNode;
  readonly tone?: InlineFeedbackTone;
}

/** Contextual feedback that does not introduce another card into the layout. */
export function InlineFeedback({
  action,
  className = "",
  description,
  title,
  tone = "info",
}: InlineFeedbackProps) {
  const titleId = useId();
  const descriptionId = useId();
  const urgent = tone === "critical";

  return (
    <div
      aria-atomic="true"
      aria-describedby={descriptionId}
      aria-labelledby={title === undefined ? undefined : titleId}
      className={`or-inline-feedback or-inline-feedback--${tone} ${className}`.trim()}
      role={urgent ? "alert" : "status"}
    >
      <span aria-hidden="true" className="or-inline-feedback__marker" />
      <div className="or-inline-feedback__copy">
        {title === undefined ? null : <strong id={titleId}>{title}</strong>}
        <div id={descriptionId}>{description}</div>
      </div>
      {action === undefined ? null : (
        <div className="or-inline-feedback__action">{action}</div>
      )}
    </div>
  );
}

export function EmptyState({
  action,
  description,
  title,
  headingLevel = 2,
}: FeedbackProps) {
  const titleId = useId();
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <Surface aria-labelledby={titleId} className="or-feedback">
      <Heading id={titleId}>{title}</Heading>
      <p>{description}</p>
      {action}
    </Surface>
  );
}

export function ErrorState({
  action,
  description,
  title,
  headingLevel = 2,
}: FeedbackProps) {
  const titleId = useId();
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <Surface aria-labelledby={titleId} className="or-feedback" role="alert">
      <Heading id={titleId}>{title}</Heading>
      <p>{description}</p>
      {action}
    </Surface>
  );
}
