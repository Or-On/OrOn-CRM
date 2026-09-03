"use client";

import { errorMessage } from "../../i18n/error-message";
import { useCapability } from "../access";
import { useTranslations } from "next-intl";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type SyntheticEvent } from "react";

import type {
  AutomationRunSummary,
  AutomationSummary,
  BroadcastSummary,
} from "@or-on/crm";
import { Badge, Button, Input, Surface } from "@or-on/ui";

import { crmMutation } from "../crm";

export function OperationsPanel({
  broadcasts,
  automations,
  runs,
}: {
  readonly broadcasts: readonly BroadcastSummary[];
  readonly automations: readonly AutomationSummary[];
  readonly runs: readonly AutomationRunSummary[];
}) {
  const t = useTranslations();
  const canEdit = useCapability("campaigns:manage");
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
      setError(errorMessage(caught, t, "operations.failed"));
      return false;
    } finally {
      setPending(false);
    }
  }
  async function createCampaign(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const saved = await run(() =>
      crmMutation("/api/campaigns", {
        name: data.get("name"),
        body: data.get("body"),
      }),
    );
    if (saved) form.reset();
  }
  async function createAutomation(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const saved = await run(() =>
      crmMutation("/api/automations", {
        name: data.get("name"),
        description: data.get("description"),
      }),
    );
    if (saved) form.reset();
  }
  return (
    <div className="operations-grid">
      <Surface level="raised">
        <h2>{t("operations.campaigns")}</h2>
        <form
          className="feature-form"
          onSubmit={(event) => void createCampaign(event)}
        >
          <fieldset className="form-fieldset" disabled={pending || !canEdit}>
            {!canEdit ? (
              <p className="public-note">{t("common.readOnly")}</p>
            ) : null}
            <Input
              id="campaign-name"
              label={t("operations.campaignName")}
              name="name"
              required
            />
            <Input
              id="campaign-body"
              label={t("operations.body")}
              name="body"
              required
            />
            <Button disabled={pending || !canEdit} type="submit">
              {t("operations.draft")}
            </Button>
          </fieldset>
        </form>
        <div className="operation-list">
          {broadcasts.map((broadcast) => (
            <article key={broadcast.id}>
              <div>
                <strong>{broadcast.name}</strong>
                <p>
                  {t("operations.delivered", {
                    delivered: broadcast.deliveredCount,
                    total: broadcast.totalRecipients,
                  })}
                </p>
              </div>
              <Badge
                label={
                  t.has(`status.${broadcast.status}`)
                    ? t(`status.${broadcast.status}`)
                    : t("common.unknown")
                }
                tone={broadcast.status === "sent" ? "positive" : "info"}
              />
              {broadcast.status === "draft" ? (
                <Button
                  disabled={pending || !canEdit}
                  onClick={() =>
                    void run(() =>
                      crmMutation(`/api/campaigns/${broadcast.id}/deliver`, {}),
                    )
                  }
                  variant="secondary"
                >
                  {t("operations.simulate")}
                </Button>
              ) : null}
            </article>
          ))}
        </div>
      </Surface>
      <Surface>
        <h2>{t("operations.automations")}</h2>
        <form
          className="feature-form"
          onSubmit={(event) => void createAutomation(event)}
        >
          <fieldset className="form-fieldset" disabled={pending || !canEdit}>
            {!canEdit ? (
              <p className="public-note">{t("common.readOnly")}</p>
            ) : null}
            <Input
              id="automation-name"
              label={t("operations.name")}
              name="name"
              required
            />
            <Input
              id="automation-description"
              label={t("operations.description")}
              name="description"
            />
            <Button
              disabled={pending || !canEdit}
              type="submit"
              variant="secondary"
            >
              {t("operations.create")}
            </Button>
          </fieldset>
        </form>
        <div className="operation-list">
          {automations.map((automation) => (
            <article key={automation.id}>
              <div>
                <strong>{automation.name}</strong>
                <p>
                  {t("operations.version", {
                    version: automation.version,
                    status: t(`status.${automation.validationStatus}`),
                  })}
                </p>
              </div>
              <Badge
                label={t(
                  automation.published ? "status.published" : "status.draft",
                )}
                tone={automation.published ? "positive" : "neutral"}
              />
              {automation.executionKind !== "empty" ? (
                <Link className="text-link" href="/orchestration">
                  {t("operations.canonical")}
                </Link>
              ) : !automation.published ? (
                <Button
                  disabled={pending || !canEdit}
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
                  {t("operations.publish")}
                </Button>
              ) : (
                <Button
                  disabled={pending || !canEdit}
                  onClick={() =>
                    void run(() =>
                      crmMutation(`/api/automations/${automation.id}/run`, {}),
                    )
                  }
                  variant="quiet"
                >
                  {t("operations.run")}
                </Button>
              )}
            </article>
          ))}
        </div>
        <div className="operation-list" aria-label={t("operations.runs")}>
          {runs.map((automationRun) => (
            <article key={automationRun.id}>
              <div>
                <strong>{t("operations.manual")}</strong>
                <p>
                  {t("operations.trace", { id: automationRun.id.slice(0, 8) })}
                </p>
              </div>
              <Badge
                label={
                  t.has(`status.${automationRun.status}`)
                    ? t(`status.${automationRun.status}`)
                    : t("common.unknown")
                }
                tone={
                  automationRun.status === "succeeded" ? "positive" : "info"
                }
              />
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
