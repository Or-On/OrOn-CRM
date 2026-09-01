"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import type { AutomationSummary, BroadcastSummary } from "@or-on/crm";
import { Badge, Button, Input, Surface } from "@or-on/ui";

import { crmMutation } from "../crm";

export function OperationsPanel({
  broadcasts,
  automations,
}: {
  readonly broadcasts: readonly BroadcastSummary[];
  readonly automations: readonly AutomationSummary[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function run(operation: () => Promise<unknown>) {
    setPending(true);
    setError(undefined);
    try {
      await operation();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Operation failed");
    } finally {
      setPending(false);
    }
  }
  async function createCampaign(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run(() =>
      crmMutation("/api/campaigns", {
        name: data.get("name"),
        body: data.get("body"),
      }),
    );
    event.currentTarget.reset();
  }
  async function createAutomation(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run(() =>
      crmMutation("/api/automations", {
        name: data.get("name"),
        description: data.get("description"),
      }),
    );
    event.currentTarget.reset();
  }
  return (
    <div className="operations-grid">
      <Surface level="raised">
        <h2>WhatsApp simulator campaigns</h2>
        <form
          className="feature-form"
          onSubmit={(event) => void createCampaign(event)}
        >
          <Input
            id="campaign-name"
            label="Campaign name"
            name="name"
            required
          />
          <Input
            id="campaign-body"
            label="Message template"
            name="body"
            required
          />
          <Button disabled={pending} type="submit">
            Create draft
          </Button>
        </form>
        <div className="operation-list">
          {broadcasts.map((broadcast) => (
            <article key={broadcast.id}>
              <div>
                <strong>{broadcast.name}</strong>
                <p>
                  {broadcast.deliveredCount}/{broadcast.totalRecipients}{" "}
                  delivered
                </p>
              </div>
              <Badge
                label={broadcast.status}
                tone={broadcast.status === "sent" ? "positive" : "info"}
              />
              {broadcast.status === "draft" ? (
                <Button
                  disabled={pending}
                  onClick={() =>
                    void run(() =>
                      crmMutation(`/api/campaigns/${broadcast.id}/deliver`, {}),
                    )
                  }
                  variant="secondary"
                >
                  Run simulator
                </Button>
              ) : null}
            </article>
          ))}
        </div>
      </Surface>
      <Surface>
        <h2>Automation drafts</h2>
        <form
          className="feature-form"
          onSubmit={(event) => void createAutomation(event)}
        >
          <Input
            id="automation-name"
            label="Automation name"
            name="name"
            required
          />
          <Input
            id="automation-description"
            label="Description"
            name="description"
          />
          <Button disabled={pending} type="submit" variant="secondary">
            Create empty graph
          </Button>
        </form>
        <div className="operation-list">
          {automations.map((automation) => (
            <article key={automation.id}>
              <div>
                <strong>{automation.name}</strong>
                <p>
                  Version {String(automation.version)} ·{" "}
                  {automation.validationStatus}
                </p>
              </div>
              <Badge
                label={automation.published ? "published" : "draft"}
                tone={automation.published ? "positive" : "neutral"}
              />
              {!automation.published ? (
                <Button
                  disabled={pending}
                  onClick={() =>
                    void run(() =>
                      crmMutation(
                        `/api/automations/${automation.id}/publish`,
                        {},
                      ),
                    )
                  }
                  variant="quiet"
                >
                  Publish
                </Button>
              ) : null}
            </article>
          ))}
        </div>
      </Surface>
      {error === undefined ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
