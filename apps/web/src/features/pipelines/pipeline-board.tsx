"use client";

import { CircleDollarSign } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { PipelineBoard as PipelineBoardData } from "@or-on/crm";
import { Badge, EmptyState, Surface } from "@or-on/ui";

import { crmMutation } from "../crm";

export function PipelineBoard({
  boards,
}: {
  readonly boards: readonly PipelineBoardData[];
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string>();
  const board = boards[0];
  if (board === undefined)
    return (
      <EmptyState
        description="The fictional development seed creates the first pipeline."
        title="No pipeline configured"
      />
    );
  async function move(dealId: string, stageId: string) {
    setPendingId(dealId);
    try {
      await crmMutation(`/api/crm/deals/${dealId}/stage`, { stageId });
      router.refresh();
    } finally {
      setPendingId(undefined);
    }
  }
  return (
    <div className="pipeline-board">
      {board.stages.map((stage) => {
        const deals = board.deals.filter((deal) => deal.stageId === stage.id);
        const value = deals.reduce((sum, deal) => sum + Number(deal.value), 0);
        return (
          <section className="pipeline-column" key={stage.id}>
            <header>
              <div>
                <h2>{stage.name}</h2>
                <p>{deals.length} deals</p>
              </div>
              <Badge label={`$${value.toLocaleString()}`} tone="neutral" />
            </header>
            <div className="pipeline-cards">
              {deals.map((deal) => (
                <Surface className="deal-card" key={deal.id}>
                  <div className="deal-card__value">
                    <CircleDollarSign aria-hidden="true" size={15} />
                    {deal.currency} {Number(deal.value).toLocaleString()}
                  </div>
                  <h3>{deal.title}</h3>
                  <p>{deal.contactName ?? "No contact"}</p>
                  <label htmlFor={`stage-${deal.id}`}>Move stage</label>
                  <select
                    disabled={pendingId === deal.id}
                    id={`stage-${deal.id}`}
                    onChange={(event) => void move(deal.id, event.target.value)}
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
  );
}
