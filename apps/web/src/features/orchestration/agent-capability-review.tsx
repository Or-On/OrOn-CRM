"use client";

import { useLocale } from "next-intl";
import type { AgentProfileSummary } from "@or-on/crm";
import { Badge, Button } from "@or-on/ui";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { capabilityCopy } from "./agent-capability-copy";

/**
 * Draft, published, assigned and running are shown as separate facts, and
 * the actions a version can take are listed from its capabilities — never
 * inferred from the prompt. Prompt warnings are labelled as hints.
 */
export function AgentCapabilityReview({
  agent,
  canEdit,
  pending,
  rebind,
}: {
  readonly agent: AgentProfileSummary;
  readonly canEdit: boolean;
  readonly pending: boolean;
  readonly rebind: (versionId: string) => void;
}) {
  const copy = capabilityCopy(useLocale());
  const { review, lifecycle } = agent;
  return (
    <>
      <section className="agent-lifecycle" aria-label={copy.lifecycleTitle}>
        <h4>{copy.lifecycleTitle}</h4>
        <ul className="agent-lifecycle__states">
          {lifecycle.draftVersion === null ? null : (
            <li>
              <Badge
                label={copy.draft(lifecycle.draftVersion)}
                tone="neutral"
              />
            </li>
          )}
          <li>
            <Badge
              label={
                agent.publishedVersion === null
                  ? copy.unpublished
                  : copy.published(agent.publishedVersion)
              }
              tone={agent.publishedVersion === null ? "neutral" : "positive"}
            />
          </li>
          <li>
            {copy.assigned(
              lifecycle.assignedConversations,
              lifecycle.assignedFlows,
            )}
          </li>
          <li>{copy.running(lifecycle.runningCalls)}</li>
        </ul>
        {lifecycle.staleConversations > 0 &&
        agent.publishedVersion !== null &&
        agent.publishedVersionId !== null ? (
          <div className="agent-lifecycle__stale" role="status">
            <AlertTriangle aria-hidden="true" size={16} />
            <p>
              {copy.stale(lifecycle.staleConversations, agent.publishedVersion)}
              <br />
              <small>{copy.rebindHint}</small>
            </p>
            <Button
              busy={pending}
              disabled={!canEdit}
              size="small"
              variant="secondary"
              onClick={() => {
                if (agent.publishedVersionId !== null)
                  rebind(agent.publishedVersionId);
              }}
            >
              <RefreshCw aria-hidden="true" size={15} />
              {copy.rebind(agent.publishedVersion)}
            </Button>
          </div>
        ) : null}
      </section>
      <section className="agent-review" aria-label={copy.actionsTitle}>
        <h4>{copy.actionsTitle}</h4>
        {review.enabledActions.length === 0 ? (
          <p>{copy.noActions}</p>
        ) : (
          <ul>
            {review.enabledActions.map((action) => (
              <li key={action.name}>
                <code dir="ltr">{action.name}</code> — {action.description}
              </li>
            ))}
          </ul>
        )}
        {agent.leadFieldSchema === null ? null : (
          <>
            <h5>
              {copy.fieldsTitle}:{" "}
              <bdi>
                {agent.leadFieldSchema.name} v{agent.leadFieldSchema.version}
              </bdi>
            </h5>
            <ul className="agent-review__fields">
              {review.leadFields.map((field) => (
                <li key={field.key}>
                  <bdi>{field.label}</bdi> <code dir="ltr">{field.key}</code> ·{" "}
                  {copy.types[field.type]} ·{" "}
                  {field.required ? copy.required : copy.optional}
                </li>
              ))}
            </ul>
          </>
        )}
        {review.blocking.length === 0 ? null : (
          <div role="alert">
            <h5>{copy.blockingTitle}</h5>
            <ul>
              {review.blocking.map((reason) => (
                <li key={reason}>{copy.blocking[reason]}</li>
              ))}
            </ul>
          </div>
        )}
        {review.promptWarnings.length === 0 ? null : (
          <div className="agent-review__warnings">
            <h5>{copy.warningsTitle}</h5>
            <ul>
              {review.promptWarnings.map((warning) => (
                <li key={warning}>{copy.warnings[warning]}</li>
              ))}
            </ul>
            <p>
              <small>{copy.warningsHint}</small>
            </p>
          </div>
        )}
      </section>
    </>
  );
}
