"use client";

import type {
  FlowSummary,
  VoiceCampaignRunResult,
  VoiceCampaignSummary,
} from "@or-on/api-client";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  Input,
  Metric,
  Select,
  Surface,
} from "@or-on/ui";
import { Plus, RadioTower } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import { errorMessage } from "../../i18n/error-message";
import { useCapability } from "../access";
import { voiceMutation } from "./mutation";

function campaignTone(
  status: string,
): "neutral" | "positive" | "warning" | "critical" | "info" {
  if (status === "completed") return "positive";
  if (status === "failed" || status === "cancelled") return "critical";
  if (status === "paused") return "warning";
  if (status === "draft") return "neutral";
  return "info";
}

function isActiveCampaign(status: string): boolean {
  return ["active", "queued", "running", "scheduled", "in_progress"].includes(
    status,
  );
}

export function VoiceCampaignPanel({
  campaigns,
  flows,
}: {
  readonly campaigns: readonly VoiceCampaignSummary[];
  readonly flows: readonly FlowSummary[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const canEdit = useCapability("voice:operate");
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [runReceipt, setRunReceipt] = useState<VoiceCampaignRunResult>();
  const flowNames = new Map(flows.map((flow) => [flow.flow_id, flow.name]));
  const completedCalls = campaigns.reduce(
    (total, campaign) => total + campaign.completed_calls,
    0,
  );
  const activeCampaigns = campaigns.filter((campaign) =>
    isActiveCampaign(campaign.status),
  ).length;
  const failedCampaigns = campaigns.filter(
    (campaign) => campaign.status === "failed",
  ).length;
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const visible = campaigns.filter(
    (campaign) =>
      (statusFilter === "all" || campaign.status === statusFilter) &&
      `${campaign.name} ${flowNames.get(campaign.flow_id) ?? ""}`
        .toLocaleLowerCase(locale)
        .includes(query.trim().toLocaleLowerCase(locale)),
  );
  const statuses = Array.from(
    new Set(campaigns.map((campaign) => campaign.status)),
  );

  async function run<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result | undefined> {
    setPending(true);
    setError(undefined);
    try {
      const result = await operation();
      router.refresh();
      return result;
    } catch (caught) {
      setError(errorMessage(caught, t, "voice.campaignFailed"));
      return undefined;
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
    if (saved !== undefined) {
      form.reset();
      setCreateOpen(false);
    }
  }

  async function runCampaign(campaignId: string) {
    const receipt = await run(
      () =>
        voiceMutation("/api/voice/campaigns/run", {
          campaign_id: campaignId,
        }) as Promise<VoiceCampaignRunResult>,
    );
    if (receipt !== undefined) setRunReceipt(receipt);
  }

  return (
    <div className="voice-campaign-workspace">
      <section
        aria-label={t("voice.progress")}
        className="voice-campaign-summary"
      >
        <Metric
          label={t("voice.campaignsLink")}
          value={campaigns.length.toLocaleString(locale)}
        />
        <Metric
          label={t("status.active")}
          tone={activeCampaigns > 0 ? "info" : "neutral"}
          value={activeCampaigns}
        />
        <Metric
          label={t("premiumVoice.completedCalls")}
          tone="positive"
          value={completedCalls}
        />
        <Metric
          label={t("premiumVoice.failedCampaigns")}
          tone={failedCampaigns > 0 ? "critical" : "neutral"}
          value={failedCampaigns}
        />
      </section>

      <Surface className="voice-detail-index" level="raised">
        <header className="voice-detail-index__header">
          <div>
            <p className="eyebrow">{t("tenantOperations.campaignAudience")}</p>
            <h2>{t("voice.progress")}</h2>
            <p id="voice-campaign-policy-note">
              {t("voice.campaignPolicyNote")}
            </p>
          </div>
          <div className="voice-detail-index__actions">
            {!canEdit ? (
              <Badge label={t("common.readOnly")} tone="neutral" />
            ) : null}
            <Button
              aria-controls="voice-campaign-create"
              aria-expanded={createOpen}
              disabled={!canEdit}
              onClick={() => setCreateOpen((open) => !open)}
              size="small"
            >
              <Plus aria-hidden="true" size={15} />
              {t("voice.createCampaign")}
            </Button>
          </div>
        </header>

        <Dialog
          title={t("voice.createCampaign")}
          closeLabel={t("common.close")}
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          className="voice-detail-create"
        >
          <div className="voice-detail-create__intro">
            <RadioTower aria-hidden="true" size={18} />
            <div>
              <strong>{t("voice.createCampaign")}</strong>
              <p>{t("tenantOperations.campaignAudience")}</p>
            </div>
          </div>
          <form
            className="feature-form"
            id="voice-campaign-create"
            onSubmit={(event) => void create(event)}
          >
            <fieldset className="form-fieldset" disabled={pending || !canEdit}>
              {!canEdit ? (
                <p className="public-note">{t("common.readOnly")}</p>
              ) : null}
              <Input
                id="voice-campaign-name"
                data-dialog-initial-focus
                label={t("voice.campaignName")}
                name="name"
                required
              />
              <Select
                id="voice-campaign-flow"
                label={t("voice.flow")}
                name="flowId"
                required
              >
                <option value="">{t("voice.select")}</option>
                {flows.map((flow) => (
                  <option key={flow.flow_id} value={flow.flow_id}>
                    {flow.name} · v{flow.latest_version}
                  </option>
                ))}
              </Select>
              <Input
                aria-describedby="voice-campaign-policy-note"
                defaultValue="1"
                id="voice-concurrency"
                label={t("voice.concurrency")}
                max={20}
                min={1}
                name="maxConcurrent"
                required
                type="number"
              />
              <Input
                aria-describedby="voice-campaign-policy-note"
                defaultValue="1"
                id="voice-attempts"
                label={t("voice.attempts")}
                max={5}
                min={1}
                name="maxAttempts"
                required
                type="number"
              />
              <div className="voice-detail-create__submit">
                <Button
                  busy={pending}
                  disabled={!canEdit || flows.length === 0}
                  type="submit"
                >
                  {t("voice.draft")}
                </Button>
              </div>
            </fieldset>
          </form>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </Dialog>

        {runReceipt === undefined ? null : (
          <aside
            aria-live="polite"
            className="voice-campaign-receipt"
            role="status"
          >
            <div>
              <strong>{t("voice.runReceipt")}</strong>
              <span>{runReceipt.campaign.name}</span>
            </div>
            <dl>
              <div>
                <dt>{t("voice.createdCalls")}</dt>
                <dd>{runReceipt.created_calls.toLocaleString(locale)}</dd>
              </div>
              <div>
                <dt>{t("voice.skippedContacts")}</dt>
                <dd>{runReceipt.skipped_contacts.toLocaleString(locale)}</dd>
              </div>
            </dl>
          </aside>
        )}

        <div className="tenant-register-toolbar">
          <Input
            id="voice-campaign-search"
            type="search"
            label={t("tenantOperations.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select
            id="voice-campaign-status"
            label={t("inbox.status")}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">{t("tenantOperations.allStates")}</option>
            {statuses.map((value) => (
              <option key={value} value={value}>
                {t.has(`status.${value}`) ? t(`status.${value}`) : value}
              </option>
            ))}
          </Select>
          <p role="status">
            {t("tenantOperations.showing", {
              count: visible.length,
              total: campaigns.length,
            })}
          </p>
        </div>
        {campaigns.length === 0 ? (
          <div className="voice-detail-empty">
            <strong>{t("voice.noCampaigns")}</strong>
            <p>{t("tenantOperations.campaignAudience")}</p>
          </div>
        ) : visible.length === 0 ? (
          <p className="tenant-no-results">{t("tenantOperations.noMatches")}</p>
        ) : (
          <DataTable label={t("voice.progress")} minWidth="58rem">
            <thead>
              <tr>
                <th scope="col">{t("voice.campaignName")}</th>
                <th scope="col">{t("voice.flow")}</th>
                <th scope="col">{t("voice.eligibleAudience")}</th>
                <th scope="col">{t("premiumVoice.completedCalls")}</th>
                <th scope="col">{t("voice.campaignPolicyMetadata")}</th>
                <th scope="col">{t("inbox.status")}</th>
                <th scope="col">{t("status.created")}</th>
                <th scope="col">
                  <span className="or-visually-hidden">
                    {t("common.details")}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((campaign) => {
                const statusLabel = t.has(`status.${campaign.status}`)
                  ? t(`status.${campaign.status}`)
                  : t("common.unknown");
                return (
                  <tr key={campaign.id}>
                    <th scope="row">
                      <strong>{campaign.name}</strong>
                      <code dir="ltr">{campaign.id.slice(0, 8)}</code>
                    </th>
                    <td>
                      {flowNames.get(campaign.flow_id) ?? t("common.unknown")}
                    </td>
                    <td>{campaign.eligible_contacts.toLocaleString(locale)}</td>
                    <td>
                      <div className="voice-campaign-progress">
                        <span>
                          {campaign.completed_calls.toLocaleString(locale)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <dl className="voice-campaign-policy">
                        <div>
                          <dt>{t("voice.concurrency")}</dt>
                          <dd>
                            {campaign.max_concurrent.toLocaleString(locale)}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("voice.attempts")}</dt>
                          <dd>
                            {campaign.max_attempts.toLocaleString(locale)}
                          </dd>
                        </div>
                      </dl>
                    </td>
                    <td>
                      <Badge
                        label={statusLabel}
                        tone={campaignTone(campaign.status)}
                      />
                    </td>
                    <td>
                      <time dateTime={campaign.created_at}>
                        {new Date(campaign.created_at).toLocaleString(locale)}
                      </time>
                    </td>
                    <td>
                      {campaign.status !== "completed" ? (
                        <Button
                          busy={pending}
                          disabled={!canEdit}
                          onClick={() => void runCampaign(campaign.id)}
                          size="small"
                          variant="secondary"
                        >
                          {t("voice.run")}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
        <p className="voice-campaign-scope">
          {t("tenantOperations.audienceScope")}
        </p>
      </Surface>

      {error === undefined || createOpen ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
