"use client";

import { useCapability } from "../access";
import { useLocale, useTranslations } from "next-intl";

import { CircleDollarSign, GripVertical, Layers3 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type DragEvent as ReactDragEvent } from "react";

import type { Deal, PipelineBoard as PipelineBoardData } from "@or-on/crm";
import { Badge, EmptyState, Select, Surface } from "@or-on/ui";

import { crmMutation } from "../crm";
import { formatAmount, sumAmounts } from "./amounts";

function currencyTotals(deals: readonly Deal[]) {
  return [...new Set(deals.map((deal) => deal.currency))]
    .sort()
    .map((currency) => ({
      currency,
      value: sumAmounts(
        deals
          .filter((deal) => deal.currency === currency)
          .map((deal) => deal.value),
      ),
    }));
}

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
  const [stageOverrides, setStageOverrides] = useState<
    Readonly<Record<string, string>>
  >({});
  const [draggingId, setDraggingId] = useState<string>();
  const [dragTargetStageId, setDragTargetStageId] = useState<string>();
  const board = boards.find((item) => item.id === selectedId) ?? boards[0];

  useEffect(() => {
    setStageOverrides({});
  }, [boards]);

  if (board === undefined)
    return (
      <EmptyState
        description={t("pipelines.emptyHint")}
        title={t("pipelines.empty")}
      />
    );
  const activeBoard = board;

  function currentStage(deal: Deal): string {
    return stageOverrides[deal.id] ?? deal.stageId;
  }

  async function move(dealId: string, stageId: string) {
    const deal = activeBoard.deals.find((candidate) => candidate.id === dealId);
    const stageExists = activeBoard.stages.some(
      (stage) => stage.id === stageId,
    );
    if (
      !canEdit ||
      deal === undefined ||
      !stageExists ||
      pendingId !== undefined
    )
      return;
    const previousStageId = currentStage(deal);
    if (previousStageId === stageId) return;

    setStageOverrides((current) => ({ ...current, [dealId]: stageId }));
    setPendingId(dealId);
    setFailed(false);
    try {
      await crmMutation(`/api/crm/deals/${dealId}/stage`, { stageId });
      router.refresh();
    } catch {
      setStageOverrides((current) => {
        if (previousStageId === deal.stageId) {
          return Object.fromEntries(
            Object.entries(current).filter(([id]) => id !== dealId),
          );
        }
        return { ...current, [dealId]: previousStageId };
      });
      setFailed(true);
    } finally {
      setPendingId(undefined);
    }
  }

  function startDrag(event: ReactDragEvent<HTMLElement>, dealId: string) {
    if (!canEdit || pendingId !== undefined) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dealId);
    setDraggingId(dealId);
  }

  function drop(event: ReactDragEvent<HTMLElement>, stageId: string) {
    event.preventDefault();
    const dealId = event.dataTransfer.getData("text/plain") || draggingId;
    setDraggingId(undefined);
    setDragTargetStageId(undefined);
    if (dealId) void move(dealId, stageId);
  }

  const boardTotals = currencyTotals(
    activeBoard.deals.filter((deal) => deal.status === "open"),
  );

  return (
    <div className="feature-stack pipeline-workspace">
      <header className="pipeline-summary">
        <div className="pipeline-summary__identity">
          <span className="pipeline-summary__icon" aria-hidden="true">
            <Layers3 size={18} />
          </span>
          <div>
            <strong>{activeBoard.name}</strong>
            <span>
              {t("pipelines.deals", { count: activeBoard.deals.length })}
              {" · "}
              {t("premiumPrimary.pipelineStages", {
                count: activeBoard.stages.length,
              })}
            </span>
          </div>
        </div>
        <div className="pipeline-selector">
          <Select
            id="pipeline-selector"
            label={t("pipelines.choose")}
            value={activeBoard.id}
            disabled={pendingId !== undefined}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setFailed(false);
              setDraggingId(undefined);
              setDragTargetStageId(undefined);
            }}
          >
            {boards.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </div>
        <div
          className="pipeline-summary__totals"
          aria-label={t("premiumPrimary.pipelineOpenValue")}
        >
          <span>{t("premiumPrimary.pipelineOpenValue")}</span>
          {boardTotals.map(({ currency, value }) => (
            <strong key={currency}>
              <bdi>{formatAmount(value, currency, locale)}</bdi>
            </strong>
          ))}
          {boardTotals.length === 0 ? <strong>—</strong> : null}
        </div>
      </header>

      <nav
        className="pipeline-distribution"
        aria-label={t("pipelines.distribution")}
      >
        {activeBoard.stages.map((stage, stageIndex) => {
          const count = activeBoard.deals.filter(
            (deal) => currentStage(deal) === stage.id,
          ).length;
          return (
            <a key={stage.id} href={`#pipeline-stage-${stage.id}`}>
              <span>
                <span>
                  <small>
                    {new Intl.NumberFormat(locale, {
                      minimumIntegerDigits: 2,
                    }).format(stageIndex + 1)}
                  </small>
                  <bdi>{stage.name}</bdi>
                </span>
                <strong>{count.toLocaleString(locale)}</strong>
              </span>
              <meter
                aria-label={stage.name}
                min={0}
                max={Math.max(1, activeBoard.deals.length)}
                value={count}
              />
            </a>
          );
        })}
      </nav>

      <div className="pipeline-workspace__feedback" aria-live="polite">
        {pendingId ? <span>{t("common.saving")}</span> : null}
        {failed ? (
          <p role="alert" className="form-error">
            {t("pipelines.failed")}
          </p>
        ) : null}
      </div>

      <div className="pipeline-board" aria-label={activeBoard.name}>
        {activeBoard.stages.map((stage) => {
          const deals = activeBoard.deals.filter(
            (deal) => currentStage(deal) === stage.id,
          );
          const totals = currencyTotals(deals);
          const headingId = `pipeline-stage-${stage.id}`;
          const isDropTarget = dragTargetStageId === stage.id;
          return (
            <section
              aria-labelledby={headingId}
              className={`pipeline-column${isDropTarget ? " pipeline-column--drop-target" : ""}`}
              key={stage.id}
              onDragEnter={(event) => {
                if (canEdit && draggingId) {
                  event.preventDefault();
                  setDragTargetStageId(stage.id);
                }
              }}
              onDragOver={(event) => {
                if (canEdit && draggingId) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => drop(event, stage.id)}
            >
              <header className="pipeline-column__header">
                <div>
                  <h2 id={headingId}>
                    <bdi>{stage.name}</bdi>
                  </h2>
                  <p>{t("pipelines.deals", { count: deals.length })}</p>
                </div>
                <div
                  className="pipeline-totals"
                  aria-label={t("pipelines.totals")}
                >
                  {totals.map(({ currency, value }) => (
                    <Badge
                      key={currency}
                      label={formatAmount(value, currency, locale)}
                      tone="neutral"
                    />
                  ))}
                </div>
              </header>
              <div className="pipeline-cards">
                {deals.length === 0 ? (
                  <p className="pipeline-column__empty">
                    {t("pipelines.emptyStage")}
                  </p>
                ) : null}
                {deals.map((deal) => {
                  const isPending = pendingId === deal.id;
                  const isDragging = draggingId === deal.id;
                  return (
                    <Surface
                      aria-busy={isPending || undefined}
                      as="article"
                      className={`deal-card${isPending ? " deal-card--pending" : ""}${isDragging ? " deal-card--dragging" : ""}`}
                      draggable={canEdit && pendingId === undefined}
                      key={deal.id}
                      onDragEnd={() => {
                        setDraggingId(undefined);
                        setDragTargetStageId(undefined);
                      }}
                      onDragStart={(event) => startDrag(event, deal.id)}
                    >
                      <div className="deal-card__topline">
                        <span
                          className="deal-card__drag-handle"
                          aria-hidden="true"
                        >
                          <GripVertical size={15} />
                        </span>
                        <div className="deal-card__top-actions">
                          <Badge
                            label={t(`status.${deal.status}`)}
                            tone={
                              deal.status === "won"
                                ? "positive"
                                : deal.status === "lost"
                                  ? "critical"
                                  : "neutral"
                            }
                          />
                        </div>
                      </div>
                      <h3>
                        <bdi>{deal.title}</bdi>
                      </h3>
                      <p className="deal-card__contact">
                        {deal.contactId ? (
                          <Link href={`/contacts/${deal.contactId}`}>
                            <bdi>
                              {deal.contactName ?? t("pipelines.noContact")}
                            </bdi>
                          </Link>
                        ) : (
                          t("pipelines.noContact")
                        )}
                      </p>
                      <div className="deal-card__value">
                        <CircleDollarSign aria-hidden="true" size={15} />
                        <bdi>
                          {formatAmount(deal.value, deal.currency, locale)}
                        </bdi>
                      </div>
                      <time
                        className="deal-card__updated"
                        dateTime={deal.updatedAt}
                      >
                        {t("premiumPrimary.pipelineUpdated", {
                          date: new Intl.DateTimeFormat(locale, {
                            day: "numeric",
                            month: "short",
                          }).format(new Date(deal.updatedAt)),
                        })}
                      </time>
                      <div className="deal-card__move">
                        <Select
                          disabled={pendingId !== undefined || !canEdit}
                          id={`stage-${deal.id}`}
                          label={t("pipelines.move")}
                          onChange={(event) =>
                            void move(deal.id, event.target.value)
                          }
                          value={currentStage(deal)}
                        >
                          {activeBoard.stages.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                    </Surface>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
