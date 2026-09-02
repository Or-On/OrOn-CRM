"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import type { FlowSummary, VoiceCampaignSummary } from "@or-on/api-client";
import { Badge, Button, Input, Surface } from "@or-on/ui";

import { voiceMutation } from "./mutation";

export function VoiceCampaignPanel({
  campaigns,
  flows,
}: {
  readonly campaigns: readonly VoiceCampaignSummary[];
  readonly flows: readonly FlowSummary[];
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
      setError(
        caught instanceof Error ? caught.message : "Campaign operation failed",
      );
    } finally {
      setPending(false);
    }
  }
  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await run(() =>
      voiceMutation("/api/voice/campaigns", {
        name: data.get("name"),
        flow_id: data.get("flowId"),
        max_concurrent: Number(data.get("maxConcurrent")),
        max_attempts: Number(data.get("maxAttempts")),
      }),
    );
    form.reset();
  }
  return (
    <div className="voice-grid">
      <Surface level="raised">
        <p className="eyebrow">Consent-aware simulator</p>
        <h2>Create voice campaign</h2>
        <form className="feature-form" onSubmit={(event) => void create(event)}>
          <Input
            id="voice-campaign-name"
            label="Campaign name"
            name="name"
            required
          />
          <label htmlFor="voice-campaign-flow">Published flow</label>
          <select id="voice-campaign-flow" name="flowId" required>
            <option value="">Select flow</option>
            {flows.map((flow) => (
              <option key={flow.flow_id} value={flow.flow_id}>
                {flow.name}
              </option>
            ))}
          </select>
          <Input
            defaultValue="1"
            id="voice-concurrency"
            label="Concurrency (1–20)"
            max={20}
            min={1}
            name="maxConcurrent"
            type="number"
          />
          <Input
            defaultValue="1"
            id="voice-attempts"
            label="Maximum attempts (1–5)"
            max={5}
            min={1}
            name="maxAttempts"
            type="number"
          />
          <Button disabled={pending || flows.length === 0} type="submit">
            Create draft
          </Button>
        </form>
      </Surface>
      <Surface>
        <h2>Campaign progress</h2>
        <div className="operation-list">
          {campaigns.length === 0 ? (
            <p>No voice campaigns yet.</p>
          ) : (
            campaigns.map((campaign) => (
              <article key={campaign.id}>
                <div>
                  <strong>{campaign.name}</strong>
                  <p>
                    {campaign.completed_calls}/{campaign.eligible_contacts}{" "}
                    completed · concurrency {campaign.max_concurrent}
                  </p>
                </div>
                <Badge
                  label={campaign.status}
                  tone={campaign.status === "completed" ? "positive" : "info"}
                />
                {campaign.status !== "completed" ? (
                  <Button
                    disabled={pending}
                    onClick={() =>
                      void run(() =>
                        voiceMutation("/api/voice/campaigns/run", {
                          campaign_id: campaign.id,
                        }),
                      )
                    }
                    variant="secondary"
                  >
                    Run simulator
                  </Button>
                ) : null}
              </article>
            ))
          )}
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
