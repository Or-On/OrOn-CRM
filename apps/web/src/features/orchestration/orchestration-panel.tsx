"use client";

import { errorMessage } from "../../i18n/error-message";
import { activityLabel } from "../../i18n/activity-label";
import { useCapability } from "../access";
import { useTranslations, useLocale } from "next-intl";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type SyntheticEvent } from "react";

import type {
  AgentProfileSummary,
  AutomationSummary,
  ContactActivity,
  ContactSummary,
  ConversationSummary,
  CrossChannelUsage,
  HandoffSummary,
  VoiceOutcomeSummary,
} from "@or-on/crm";
import { Badge, Button, Input, Surface } from "@or-on/ui";

import { crmMutation } from "../crm";

function idempotencyKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function OrchestrationPanel({
  activity,
  agents,
  conversations,
  flows,
  handoffs,
  usage,
  voiceOutcomes,
  contacts = [],
  activityContactId,
}: {
  readonly activity: readonly ContactActivity[];
  readonly agents: readonly AgentProfileSummary[];
  readonly conversations: readonly ConversationSummary[];
  readonly flows: readonly AutomationSummary[];
  readonly handoffs: readonly HandoffSummary[];
  readonly usage: CrossChannelUsage;
  readonly voiceOutcomes: readonly VoiceOutcomeSummary[];
  readonly contacts?: readonly ContactSummary[];
  readonly activityContactId?: string;
}) {
  const t = useTranslations();
  const canEdit = useCapability("flows:manage");
  const locale = useLocale();
  const canHandoff = useCapability("messaging:operate");
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
      setError(errorMessage(caught, t, "orchestration.failed"));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function createAgent(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const saved = await run(() =>
      crmMutation("/api/orchestration/agents", {
        name: data.get("name"),
        systemPrompt: data.get("systemPrompt"),
        locale: data.get("locale"),
        channels: ["voice", "whatsapp"],
      }),
    );
    if (saved) form.reset();
  }

  async function createFlow(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const saved = await run(() =>
      crmMutation("/api/orchestration/flows", {
        name: data.get("name"),
        agentProfileVersionId: data.get("agentProfileVersionId"),
        flow: {
          schemaVersion: "1.0",
          channels: ["voice", "whatsapp"],
          nodes: [
            { id: "start", type: "start" },
            {
              id: "crm",
              type: "crm.update",
              configuration: { field: "company", value: data.get("company") },
            },
            {
              id: "voice",
              type: "voice.call",
              configuration: {
                flowId: data.get("voiceFlowId"),
                flowVersion: Number(data.get("voiceFlowVersion")),
              },
            },
            {
              id: "whatsapp",
              type: "message.send",
              configuration: { text: data.get("messageText") },
            },
            {
              id: "handoff",
              type: "handoff",
              configuration: {
                reason: t("orchestration.reason"),
              },
            },
            { id: "end", type: "end" },
          ],
          edges: [
            { id: "start-crm", source: "start", target: "crm" },
            { id: "crm-voice", source: "crm", target: "voice" },
            { id: "crm-whatsapp", source: "crm", target: "whatsapp" },
            { id: "voice-handoff", source: "voice", target: "handoff" },
            {
              id: "whatsapp-handoff",
              source: "whatsapp",
              target: "handoff",
            },
            { id: "handoff-end", source: "handoff", target: "end" },
          ],
        },
      }),
    );
    if (saved) form.reset();
  }

  async function simulate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const kindValue = data.get("kind");
    if (typeof kindValue !== "string")
      throw new TypeError(t("orchestration.required"));
    const kind = kindValue;
    await run(() =>
      crmMutation(
        "/api/orchestration/simulate",
        {
          kind,
          conversationId: data.get("conversationId"),
          sessionId: data.get("sessionId"),
        },
        { idempotencyKey: idempotencyKey(kind) },
      ),
    );
  }

  async function createHandoff(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const saved = await run(() =>
      crmMutation(
        "/api/orchestration/handoffs",
        {
          contactId: data.get("contactId"),
          sourceChannel: "whatsapp",
          reasonSafe: data.get("reasonSafe"),
        },
        { idempotencyKey: idempotencyKey("handoff") },
      ),
    );
    if (saved) form.reset();
  }

  return (
    <div className="feature-stack">
      <dl className="metric-grid" aria-label={t("orchestration.usage")}>
        <div>
          <dt>{t("orchestration.events")}</dt>
          <dd>{usage.agentEvents}</dd>
        </div>
        <div>
          <dt>{t("orchestration.tokens")}</dt>
          <dd>{usage.inputTokens + usage.outputTokens}</dd>
        </div>
        <div>
          <dt>{t("orchestration.sessions")}</dt>
          <dd>{usage.voiceSessions}</dd>
        </div>
        <div>
          <dt>{t("orchestration.latency")}</dt>
          <dd>
            {usage.averageLatencyMs === null
              ? t("orchestration.noLatency")
              : `${usage.averageLatencyMs.toString()} ms`}{" "}
            ·{" "}
            {usage.unpricedEvents > 0
              ? t("orchestration.unpriced")
              : t("orchestration.noUsage")}
          </dd>
        </div>
      </dl>

      <div className="operations-grid">
        <Surface level="raised">
          <h2>{t("orchestration.agents")}</h2>
          <p className="feature-copy">{t("orchestration.agentsHint")}</p>
          <form
            className="feature-form"
            onSubmit={(event) => void createAgent(event)}
          >
            <fieldset className="form-fieldset" disabled={pending || !canEdit}>
              {!canEdit ? (
                <p className="public-note">{t("common.readOnly")}</p>
              ) : null}
              <Input
                id="agent-name"
                label={t("orchestration.agentName")}
                name="name"
                required
              />
              <Input
                id="agent-locale"
                label={t("management.locale")}
                name="locale"
                placeholder="he-IL"
              />
              <label htmlFor="agent-prompt">{t("orchestration.prompt")}</label>
              <textarea
                id="agent-prompt"
                name="systemPrompt"
                required
                rows={4}
              />
              <Button disabled={pending || !canEdit} type="submit">
                {t("orchestration.draft")}
              </Button>
            </fieldset>
          </form>
          <div className="operation-list">
            {agents.map((agent) => (
              <article key={agent.id}>
                <div>
                  <strong>{agent.name}</strong>
                  <p>
                    v{agent.version ?? "—"} · {agent.channels.join(" + ")}
                  </p>
                </div>
                <Badge
                  label={t(
                    agent.published ? "status.published" : "status.draft",
                  )}
                  tone={agent.published ? "positive" : "neutral"}
                />
                {!agent.published ? (
                  <Button
                    disabled={pending || !canEdit}
                    onClick={() =>
                      void run(() =>
                        crmMutation(
                          `/api/orchestration/agents/${agent.id}/publish`,
                          {},
                        ),
                      )
                    }
                    variant="quiet"
                  >
                    {t("orchestration.publish")}
                  </Button>
                ) : null}
              </article>
            ))}
          </div>
        </Surface>

        <Surface>
          <h2>{t("orchestration.flows")}</h2>
          <p className="feature-copy">{t("orchestration.flowsHint")}</p>
          <form
            className="feature-form"
            onSubmit={(event) => void createFlow(event)}
          >
            <fieldset className="form-fieldset" disabled={pending || !canEdit}>
              {!canEdit ? (
                <p className="public-note">{t("common.readOnly")}</p>
              ) : null}
              <Input
                id="flow-name"
                label={t("orchestration.flowName")}
                name="name"
                required
              />
              <Input
                id="flow-company"
                label={t("orchestration.company")}
                name="company"
                required
              />
              <Input
                id="flow-message"
                label={t("orchestration.message")}
                name="messageText"
                required
              />
              <Input
                id="flow-voice-id"
                label={t("orchestration.flowId")}
                name="voiceFlowId"
                required
              />
              <Input
                id="flow-voice-version"
                label={t("orchestration.flowVersion")}
                name="voiceFlowVersion"
                type="number"
                min="1"
                defaultValue="1"
                required
              />
              <label htmlFor="flow-agent">
                {t("orchestration.agentVersion")}
              </label>
              <select id="flow-agent" name="agentProfileVersionId" required>
                <option value="">{t("orchestration.selectAgent")}</option>
                {agents
                  .filter((agent) => agent.published && agent.versionId)
                  .map((agent) => (
                    <option key={agent.id} value={agent.versionId ?? ""}>
                      {agent.name} · v{agent.version}
                    </option>
                  ))}
              </select>
              <Button
                disabled={pending || !canEdit}
                type="submit"
                variant="secondary"
              >
                {t("orchestration.createFlow")}
              </Button>
            </fieldset>
          </form>
          <div className="operation-list">
            {flows.map((flow) => (
              <article key={flow.id}>
                <div>
                  <strong>{flow.name}</strong>
                  <p>{t("common.version", { version: flow.version })}</p>
                </div>
                <Badge
                  label={t(
                    flow.published ? "status.published" : "status.draft",
                  )}
                  tone={flow.published ? "positive" : "neutral"}
                />
                {flow.executionKind !== "canonical" ? (
                  <Link className="text-link" href="/operations">
                    {t("operations.automations")}
                  </Link>
                ) : !flow.published ? (
                  <Button
                    disabled={pending || !canEdit}
                    onClick={() =>
                      void run(() =>
                        crmMutation(
                          `/api/orchestration/flows/${flow.id}/publish`,
                          {},
                        ),
                      )
                    }
                    variant="quiet"
                  >
                    {t("orchestration.publish")}
                  </Button>
                ) : null}
                {flow.published && flow.executionKind === "canonical" ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget;
                      const data = new FormData(form);
                      void run(() =>
                        crmMutation(
                          `/api/orchestration/flows/${flow.id}/simulate`,
                          {
                            conversationId: data.get("conversationId"),
                            channel: data.get("channel"),
                          },
                          { idempotencyKey: idempotencyKey("flow") },
                        ),
                      );
                    }}
                  >
                    <fieldset
                      className="form-fieldset"
                      disabled={pending || !canEdit}
                    >
                      {!canEdit ? (
                        <p className="public-note">{t("common.readOnly")}</p>
                      ) : null}
                      <label htmlFor={`flow-conversation-${flow.id}`}>
                        {t("orchestration.conversation")}
                      </label>
                      <select
                        id={`flow-conversation-${flow.id}`}
                        name="conversationId"
                        required
                      >
                        {conversations.map((conversation) => (
                          <option key={conversation.id} value={conversation.id}>
                            {conversation.contactName}
                          </option>
                        ))}
                      </select>
                      <label htmlFor={`flow-channel-${flow.id}`}>
                        {t("orchestration.channel")}
                      </label>
                      <select id={`flow-channel-${flow.id}`} name="channel">
                        <option value="voice">
                          {t("orchestration.voice")}
                        </option>
                        <option value="whatsapp">
                          {t("orchestration.whatsapp")}
                        </option>
                      </select>
                      <Button disabled={pending || !canEdit} type="submit">
                        {t("orchestration.queueFlow")}
                      </Button>
                      <p>{t("orchestration.flowHint")}</p>
                    </fieldset>
                  </form>
                ) : null}
              </article>
            ))}
          </div>
        </Surface>
      </div>

      <div className="operations-grid">
        <Surface>
          <h2>{t("orchestration.simulations")}</h2>
          <p className="feature-copy">{t("orchestration.simulationHint")}</p>
          <form
            className="feature-form"
            onSubmit={(event) => void simulate(event)}
          >
            <fieldset className="form-fieldset" disabled={pending || !canEdit}>
              {!canEdit ? (
                <p className="public-note">{t("common.readOnly")}</p>
              ) : null}
              <label htmlFor="simulation-kind">
                {t("orchestration.workflow")}
              </label>
              <select id="simulation-kind" name="kind">
                <option value="call-outcome-whatsapp">
                  {t("orchestration.callFollowup")}
                </option>
                <option value="whatsapp-crm-call">
                  {t("orchestration.messageCall")}
                </option>
              </select>
              <label htmlFor="simulation-session">
                {t("orchestration.outcome")}
              </label>
              <select id="simulation-session" name="sessionId">
                <option value="">{t("orchestration.selectCall")}</option>
                {voiceOutcomes.map((outcome) => (
                  <option key={outcome.sessionId} value={outcome.sessionId}>
                    {outcome.outcome} · {outcome.sessionId.slice(0, 8)}
                  </option>
                ))}
              </select>
              <label htmlFor="simulation-conversation">
                {t("orchestration.conversationLabel")}
              </label>
              <select id="simulation-conversation" name="conversationId">
                <option value="">{t("orchestration.notRequired")}</option>
                {conversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversation.contactName}
                  </option>
                ))}
              </select>
              <Button
                disabled={
                  pending ||
                  (voiceOutcomes.length === 0 && conversations.length === 0)
                }
                type="submit"
              >
                {t("orchestration.queue")}
              </Button>
            </fieldset>
          </form>
        </Surface>

        <Surface>
          <h2>{t("orchestration.handoffs")}</h2>
          <form
            className="feature-form"
            onSubmit={(event) => void createHandoff(event)}
          >
            <fieldset
              className="form-fieldset"
              disabled={pending || !canHandoff}
            >
              {!canHandoff ? (
                <p className="public-note">{t("common.readOnly")}</p>
              ) : null}
              <label htmlFor="handoff-contact">
                {t("orchestration.whatsappConversation")}
              </label>
              <select id="handoff-contact" name="contactId" required>
                {conversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.contactId}>
                    {conversation.contactName}
                  </option>
                ))}
              </select>
              <Input
                id="handoff-reason"
                label={t("orchestration.handoffReason")}
                name="reasonSafe"
                required
              />
              <Button
                disabled={pending || !canHandoff || conversations.length === 0}
                type="submit"
              >
                {t("orchestration.request")}
              </Button>
            </fieldset>
          </form>
          <div className="operation-list">
            {handoffs.map((handoff) => (
              <article key={handoff.id}>
                <div>
                  <strong>{handoff.reasonSafe}</strong>
                  <p>
                    {handoff.sourceChannel} ·{" "}
                    {new Date(handoff.requestedAt).toLocaleString(locale)}
                  </p>
                </div>
                <Badge
                  label={
                    t.has(`status.${handoff.status}`)
                      ? t(`status.${handoff.status}`)
                      : t("common.unknown")
                  }
                  tone={handoff.status === "resolved" ? "positive" : "info"}
                />
                {handoff.status === "pending" ? (
                  <Button
                    disabled={pending || !canHandoff}
                    onClick={() =>
                      void run(() =>
                        crmMutation(
                          `/api/orchestration/handoffs/${handoff.id}`,
                          { action: "accept" },
                          { method: "PATCH" },
                        ),
                      )
                    }
                    variant="quiet"
                  >
                    {t("orchestration.accept")}
                  </Button>
                ) : handoff.status === "accepted" ? (
                  <Button
                    disabled={pending || !canHandoff}
                    onClick={() =>
                      void run(() =>
                        crmMutation(
                          `/api/orchestration/handoffs/${handoff.id}`,
                          { action: "resolve" },
                          { method: "PATCH" },
                        ),
                      )
                    }
                    variant="quiet"
                  >
                    {t("orchestration.resolve")}
                  </Button>
                ) : null}
              </article>
            ))}
          </div>
        </Surface>
      </div>

      <Surface>
        <h2>{t("orchestration.activity")}</h2>
        {contacts.length ? (
          <form action="/orchestration" className="feature-toolbar">
            <label>
              {t("orchestration.contact")}
              <select name="contact" defaultValue={activityContactId}>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" variant="secondary">
              {t("common.details")}
            </Button>
          </form>
        ) : null}
        {activity.length === 0 ? (
          <p className="public-note">{t("orchestration.none")}</p>
        ) : null}
        <ol className="timeline">
          {activity.map((item) => (
            <li key={`${item.sourceType}-${item.eventId}`}>
              <div>
                <strong>{activityLabel(item.eventType, t)}</strong>
                <time>{new Date(item.occurredAt).toLocaleString(locale)}</time>
              </div>
              <details className="technical-details">
                <summary>{t("contacts.technical")}</summary>
                <code dir="ltr">{item.eventType}</code>
                <pre>{JSON.stringify(item.metadata, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
      </Surface>

      {error === undefined ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
