"use client";

import { useCapability } from "../access";
import { useTranslations, useLocale } from "next-intl";

import { CircleDollarSign } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { PipelineBoard as PipelineBoardData } from "@or-on/crm";
import { Badge, EmptyState, Surface } from "@or-on/ui";

import { crmMutation } from "../crm";
import { formatAmount, sumAmounts } from "./amounts";

export function PipelineBoard({
  boards,
}: {
  readonly boards: readonly PipelineBoardData[];
}) {
  const t = useTranslations();
  const canEdit = useCapability("pipelines:manage");
  const locale = useLocale();
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string>();
  const [selectedId, setSelectedId] = useState(boards[0]?.id);
  const [failed, setFailed] = useState(false);
  const board = boards.find((item) => item.id === selectedId) ?? boards[0];
  if (board === undefined)
    return (
      <EmptyState
        description={t("pipelines.emptyHint")}
        title={t("pipelines.empty")}
      />
    );
  async function move(dealId: string, stageId: string) {
    setPendingId(dealId);
    setFailed(false);
    try {
      await crmMutation(`/api/crm/deals/${dealId}/stage`, { stageId });
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setPendingId(undefined);
    }
  }
  return (
    <div className="feature-stack">
      <div className="feature-toolbar">
        <label className="pipeline-selector">
          {t("pipelines.choose")}
          <select
            value={board.id}
            disabled={pendingId !== undefined}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {boards.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {failed ? (
        <p role="alert" className="form-error">
          {t("pipelines.failed")}
        </p>
      ) : null}
      <div className="pipeline-board">
        {board.stages.map((stage) => {
          const deals = board.deals.filter((deal) => deal.stageId === stage.id);
          const currencies = [
            ...new Set(deals.map((deal) => deal.currency)),
          ].sort();
          return (
            <section className="pipeline-column" key={stage.id}>
              <header>
                <div>
                  <h2>{stage.name}</h2>
                  <p>{t("pipelines.deals", { count: deals.length })}</p>
                </div>
                <div
                  className="pipeline-totals"
                  aria-label={t("pipelines.totals")}
                >
                  {currencies.map((currency) => (
                    <Badge
                      key={currency}
                      label={formatAmount(
                        sumAmounts(
                          deals
                            .filter((deal) => deal.currency === currency)
                            .map((deal) => deal.value),
                        ),
                        currency,
                        locale,
                      )}
                      tone="neutral"
                    />
                  ))}
                </div>
              </header>
              <div className="pipeline-cards">
                {deals.length === 0 ? (
                  <p className="public-note">{t("pipelines.emptyStage")}</p>
                ) : null}
                {deals.map((deal) => (
                  <Surface className="deal-card" key={deal.id}>
                    <div className="deal-card__value">
                      <CircleDollarSign aria-hidden="true" size={15} />
                      <bdi>
                        {formatAmount(deal.value, deal.currency, locale)}
                      </bdi>
                    </div>
                    <h3>{deal.title}</h3>
                    <p>{deal.contactName ?? t("pipelines.noContact")}</p>
                    <label htmlFor={`stage-${deal.id}`}>
                      {t("pipelines.move")}
                    </label>
                    <select
                      disabled={pendingId !== undefined || !canEdit}
                      id={`stage-${deal.id}`}
                      onChange={(event) =>
                        void move(deal.id, event.target.value)
                      }
                      value={deal.stageId}
                    >
                      {board.stages.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </Surface>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
