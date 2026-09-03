"use client";

import { errorMessage } from "../../i18n/error-message";
import { useCapability } from "../access";
import { useTranslations } from "next-intl";

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
  const t = useTranslations();
  const canEdit = useCapability("voice:operate");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function run(operation: () => Promise<unknown>) {
    setPending(true);
    setError(undefined);
    try {
      await operation();
      router.refresh();
      return true;
    } catch (caught) {
      setError(errorMessage(caught, t, "voice.campaignFailed"));
      return false;
    } finally {
      setPending(false);
    }
  }
  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const saved = await run(() =>
      voiceMutation("/api/voice/campaigns", {
        name: data.get("name"),
        flow_id: data.get("flowId"),
        max_concurrent: Number(data.get("maxConcurrent")),
        max_attempts: Number(data.get("maxAttempts")),
      }),
    );
    if (saved) form.reset();
  }
  return (
    <div className="voice-grid">
      <Surface level="raised">
        <p className="eyebrow">{t("voice.consent")}</p>
        <h2>{t("voice.createCampaign")}</h2>
        <form className="feature-form" onSubmit={(event) => void create(event)}>
          <fieldset className="form-fieldset" disabled={pending || !canEdit}>
            {!canEdit ? (
              <p className="public-note">{t("common.readOnly")}</p>
            ) : null}
            <Input
              id="voice-campaign-name"
              label={t("voice.campaignName")}
              name="name"
              required
            />
            <label htmlFor="voice-campaign-flow">{t("voice.flow")}</label>
            <select id="voice-campaign-flow" name="flowId" required>
              <option value="">{t("voice.select")}</option>
              {flows.map((flow) => (
                <option key={flow.flow_id} value={flow.flow_id}>
                  {flow.name}
                </option>
              ))}
            </select>
            <Input
              defaultValue="1"
              id="voice-concurrency"
              label={t("voice.concurrency")}
              max={20}
              min={1}
              name="maxConcurrent"
              type="number"
            />
            <Input
              defaultValue="1"
              id="voice-attempts"
              label={t("voice.attempts")}
              max={5}
              min={1}
              name="maxAttempts"
              type="number"
            />
            <Button
              disabled={pending || !canEdit || flows.length === 0}
              type="submit"
            >
              {t("voice.draft")}
            </Button>
          </fieldset>
        </form>
      </Surface>
      <Surface>
        <h2>{t("voice.progress")}</h2>
        <div className="operation-list">
          {campaigns.length === 0 ? (
            <p>{t("voice.noCampaigns")}</p>
          ) : (
            campaigns.map((campaign) => (
              <article key={campaign.id}>
                <div>
                  <strong>{campaign.name}</strong>
                  <p>
                    {t("voice.counts", {
                      completed: campaign.completed_calls,
                      total: campaign.eligible_contacts,
                      concurrency: campaign.max_concurrent,
                    })}
                  </p>
                </div>
                <Badge
                  label={
                    t.has(`status.${campaign.status}`)
                      ? t(`status.${campaign.status}`)
                      : t("common.unknown")
                  }
                  tone={campaign.status === "completed" ? "positive" : "info"}
                />
                {campaign.status !== "completed" ? (
                  <Button
                    disabled={pending || !canEdit}
                    onClick={() =>
                      void run(() =>
                        voiceMutation("/api/voice/campaigns/run", {
                          campaign_id: campaign.id,
                        }),
                      )
                    }
                    variant="secondary"
                  >
                    {t("voice.run")}
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
