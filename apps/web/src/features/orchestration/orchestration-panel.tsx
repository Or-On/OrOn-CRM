"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import type {
  AgentProfileSummary,
  AutomationSummary,
  ContactActivity,
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
}: {
  readonly activity: readonly ContactActivity[];
  readonly agents: readonly AgentProfileSummary[];
  readonly conversations: readonly ConversationSummary[];
  readonly flows: readonly AutomationSummary[];
  readonly handoffs: readonly HandoffSummary[];
  readonly usage: CrossChannelUsage;
  readonly voiceOutcomes: readonly VoiceOutcomeSummary[];
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

  async function createAgent(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await run(() =>
      crmMutation("/api/orchestration/agents", {
        name: data.get("name"),
        systemPrompt: data.get("systemPrompt"),
        locale: data.get("locale"),
        channels: ["voice", "whatsapp"],
      }),
    );
    form.reset();
  }

  async function createFlow(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await run(() =>
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
                reason:
                  "Canonical simulator completed; operator follow-up requested.",
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
    form.reset();
  }

  async function simulate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const kindValue = data.get("kind");
    if (typeof kindValue !== "string") throw new TypeError("kind is required");
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
    await run(() =>
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
    form.reset();
  }

  return (
    <div className="feature-stack">
      <div className="metric-grid" aria-label="Cross-channel usage summary">
        <div>
          <dt>Agent events</dt>
          <dd>{usage.agentEvents}</dd>
        </div>
        <div>
          <dt>Token usage</dt>
          <dd>{usage.inputTokens + usage.outputTokens}</dd>
        </div>
        <div>
          <dt>Voice sessions</dt>
          <dd>{usage.voiceSessions}</dd>
        </div>
        <div>
          <dt>Latency / cost</dt>
          <dd>
            {usage.averageLatencyMs === null
              ? "No latency"
              : `${usage.averageLatencyMs.toString()} ms`}{" "}
            · {usage.unpricedEvents > 0 ? "unpriced" : "no usage"}
          </dd>
        </div>
      </div>

      <div className="operations-grid">
        <Surface level="raised">
          <h2>Versioned agent profiles</h2>
          <p className="feature-copy">
            One profile, immutable releases, and explicit voice/WhatsApp
            capabilities. Live visual agents remain deferred.
          </p>
          <form
            className="feature-form"
            onSubmit={(event) => void createAgent(event)}
          >
            <Input id="agent-name" label="Agent name" name="name" required />
            <Input
              id="agent-locale"
              label="Locale"
              name="locale"
              placeholder="he-IL"
            />
            <label htmlFor="agent-prompt">System prompt</label>
            <textarea id="agent-prompt" name="systemPrompt" required rows={4} />
            <Button disabled={pending} type="submit">
              Create draft
            </Button>
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
                  label={agent.published ? "published" : "draft"}
                  tone={agent.published ? "positive" : "neutral"}
                />
                {!agent.published ? (
                  <Button
                    disabled={pending}
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
                    Publish
                  </Button>
                ) : null}
              </article>
            ))}
          </div>
        </Surface>

        <Surface>
          <h2>Canonical flows</h2>
          <p className="feature-copy">
            A single graph compiles deterministically into retained Or-on voice
            and WACRM messaging adapters.
          </p>
          <form
            className="feature-form"
            onSubmit={(event) => void createFlow(event)}
          >
            <Input id="flow-name" label="Flow name" name="name" required />
            <Input
              id="flow-company"
              label="CRM company value for this simulation"
              name="company"
              required
            />
            <Input
              id="flow-message"
              label="Simulator message text"
              name="messageText"
              required
            />
            <Input
              id="flow-voice-id"
              label="Published voice flow UUID (from Voice flows)"
              name="voiceFlowId"
              required
            />
            <Input
              id="flow-voice-version"
              label="Published voice flow version"
              name="voiceFlowVersion"
              type="number"
              min="1"
              defaultValue="1"
              required
            />
            <label htmlFor="flow-agent">Published agent version</label>
            <select id="flow-agent" name="agentProfileVersionId" required>
              <option value="">Select agent</option>
              {agents
                .filter((agent) => agent.published && agent.versionId)
                .map((agent) => (
                  <option key={agent.id} value={agent.versionId ?? ""}>
                    {agent.name} · v{agent.version}
                  </option>
                ))}
            </select>
            <Button disabled={pending} type="submit" variant="secondary">
              Create cross-channel draft
            </Button>
          </form>
          <div className="operation-list">
            {flows.map((flow) => (
              <article key={flow.id}>
                <div>
                  <strong>{flow.name}</strong>
                  <p>Version {flow.version}</p>
                </div>
                <Badge
                  label={flow.published ? "published" : "draft"}
                  tone={flow.published ? "positive" : "neutral"}
                />
                {!flow.published ? (
                  <Button
                    disabled={pending}
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
                    Publish
                  </Button>
                ) : null}
                {flow.published ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
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
                    <label htmlFor={`flow-conversation-${flow.id}`}>
                      Simulator conversation
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
                      Simulator channel
                    </label>
                    <select id={`flow-channel-${flow.id}`} name="channel">
                      <option value="voice">Voice</option>
                      <option value="whatsapp">WhatsApp</option>
                    </select>
                    <Button disabled={pending} type="submit">
                      Queue flow simulation
                    </Button>
                    <p>
                      Local simulation only. View step completion under
                      Automations.
                    </p>
                  </form>
                ) : null}
              </article>
            ))}
          </div>
        </Surface>
      </div>

      <div className="operations-grid">
        <Surface>
          <h2>Safe cross-channel simulations</h2>
          <p className="feature-copy">
            Commands are durable and idempotent. They never contact providers.
          </p>
          <form
            className="feature-form"
            onSubmit={(event) => void simulate(event)}
          >
            <label htmlFor="simulation-kind">Workflow</label>
            <select id="simulation-kind" name="kind">
              <option value="call-outcome-whatsapp">
                Call outcome → WhatsApp follow-up
              </option>
              <option value="whatsapp-crm-call">
                WhatsApp → CRM → consented call
              </option>
            </select>
            <label htmlFor="simulation-session">Completed call outcome</label>
            <select id="simulation-session" name="sessionId">
              <option value="">Select for call follow-up</option>
              {voiceOutcomes.map((outcome) => (
                <option key={outcome.sessionId} value={outcome.sessionId}>
                  {outcome.outcome} · {outcome.sessionId.slice(0, 8)}
                </option>
              ))}
            </select>
            <label htmlFor="simulation-conversation">Conversation</label>
            <select id="simulation-conversation" name="conversationId">
              <option value="">Not required for follow-up</option>
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
              Queue simulator command
            </Button>
          </form>
        </Surface>

        <Surface>
          <h2>Human handoff queue</h2>
          <form
            className="feature-form"
            onSubmit={(event) => void createHandoff(event)}
          >
            <label htmlFor="handoff-contact">WhatsApp conversation</label>
            <select id="handoff-contact" name="contactId" required>
              {conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.contactId}>
                  {conversation.contactName}
                </option>
              ))}
            </select>
            <Input
              id="handoff-reason"
              label="Safe handoff reason"
              name="reasonSafe"
              required
            />
            <Button
              disabled={pending || conversations.length === 0}
              type="submit"
            >
              Request handoff
            </Button>
          </form>
          <div className="operation-list">
            {handoffs.map((handoff) => (
              <article key={handoff.id}>
                <div>
                  <strong>{handoff.reasonSafe}</strong>
                  <p>
                    {handoff.sourceChannel} · {handoff.requestedAt}
                  </p>
                </div>
                <Badge
                  label={handoff.status}
                  tone={handoff.status === "resolved" ? "positive" : "info"}
                />
                {handoff.status === "pending" ? (
                  <Button
                    disabled={pending}
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
                    Accept
                  </Button>
                ) : handoff.status === "accepted" ? (
                  <Button
                    disabled={pending}
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
                    Resolve
                  </Button>
                ) : null}
              </article>
            ))}
          </div>
        </Surface>
      </div>

      <Surface>
        <h2>Unified contact activity</h2>
        <ol className="timeline">
          {activity.map((item) => (
            <li key={`${item.sourceType}-${item.eventId}`}>
              <div>
                <strong>{item.eventType}</strong>
                <time>{item.occurredAt}</time>
              </div>
              <pre>{JSON.stringify(item.metadata, null, 2)}</pre>
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
