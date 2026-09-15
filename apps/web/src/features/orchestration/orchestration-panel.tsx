"use client";

import { activityLabel } from "../../i18n/activity-label";
import { errorMessage } from "../../i18n/error-message";
import { tenantDateFormatter } from "../../i18n/tenant-date-time";
import { useCapability } from "../access";
import { useLocale, useTranslations } from "next-intl";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type SyntheticEvent } from "react";
import { GitBranch, Headphones, Pencil, Plus, Trash2 } from "lucide-react";

import type {
  AgentProfileSummary,
  AutomationRunSummary,
  TenantOperationalInsights,
  AutomationSummary,
  ContactActivity,
  ContactSummary,
  ConversationSummary,
  CrossChannelUsage,
  HandoffSummary,
  VoiceOutcomeSummary,
} from "@or-on/crm";
import {
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Input,
  Metric,
  Select,
  Surface,
  Tabs,
  Textarea,
} from "@or-on/ui";

import { crmMutation } from "../crm";
import { AutomationRunHistory } from "../operations";
import { AgentRegister } from "./agent-register";
import { FlowCanvas } from "./flow-canvas";
import { orchestrationLocation } from "./location";

type OrchestrationTab = "agents" | "flows" | "activity" | "handoffs";

const nodeTypeTranslationKeys: Readonly<Record<string, string>> = {
  start: "orchestration.nodeTypes.start",
  end: "orchestration.nodeTypes.end",
  "message.send": "orchestration.nodeTypes.messageSend",
  "voice.call": "orchestration.nodeTypes.voiceCall",
  "crm.update": "orchestration.nodeTypes.crmUpdate",
  handoff: "orchestration.nodeTypes.handoff",
};

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
  initialTab = "agents",
  runs = [],
  insights,
  timezone = "UTC",
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
  readonly initialTab?: OrchestrationTab;
  readonly runs?: readonly AutomationRunSummary[];
  readonly insights?: TenantOperationalInsights;
  readonly timezone?: string;
}) {
  const t = useTranslations();
  const canEdit = useCapability("flows:manage");
  const canHandoff = useCapability("messaging:operate");
  const locale = useLocale();
  const dateTime = tenantDateFormatter(locale, timezone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<OrchestrationTab>(initialTab);
  const [selectedFlowId, setSelectedFlowId] = useState<string | undefined>(
    flows[0]?.id,
  );
  const [flowQuery, setFlowQuery] = useState("");
  const filteredFlows = flows.filter((flow) =>
    flow.name
      .toLocaleLowerCase(locale)
      .includes(flowQuery.trim().toLocaleLowerCase(locale)),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [creation, setCreation] = useState<
    "agents" | "flows" | "handoff" | "simulation" | null
  >(null);
  const [renameFlowId, setRenameFlowId] = useState<string>();
  const [deleteFlowId, setDeleteFlowId] = useState<string>();
  const hasPublishedAgent = agents.some(
    (agent) => agent.published && agent.versionId,
  );

  function openCreation(kind: "agents" | "flows") {
    setCreation(kind);
  }

  useEffect(() => setActiveTab(initialTab), [initialTab]);
  useEffect(() => {
    if (!flows.some((flow) => flow.id === selectedFlowId)) {
      setSelectedFlowId(flows[0]?.id);
    }
  }, [flows, selectedFlowId]);

  const selectedFlow =
    flows.find((flow) => flow.id === selectedFlowId) ?? flows[0];

  function selectTab(id: string) {
    if (
      id === "agents" ||
      id === "flows" ||
      id === "activity" ||
      id === "handoffs"
    ) {
      setActiveTab(id);
      window.history.replaceState(
        null,
        "",
        orchestrationLocation(id, window.location.search),
      );
    }
  }

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
    if (saved) {
      form.reset();
      setCreation(null);
    }
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
                agentVersionId: data.get("voiceAgentProfileVersionId"),
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
              configuration: { reason: t("orchestration.reason") },
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
    if (saved) {
      form.reset();
      setCreation(null);
    }
  }

  async function simulate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const kindValue = data.get("kind");
    if (typeof kindValue !== "string")
      throw new TypeError(t("orchestration.required"));
    await run(() =>
      crmMutation(
        "/api/orchestration/simulate",
        {
          kind: kindValue,
          conversationId: data.get("conversationId"),
          sessionId: data.get("sessionId"),
        },
        { idempotencyKey: idempotencyKey(kindValue) },
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
    if (saved) {
      form.reset();
      setCreation(null);
    }
  }

  return (
    <div className="orchestration-workspace">
      {insights && (activeTab === "agents" || activeTab === "flows") ? (
        <section
          className="tenant-performance-strip"
          aria-label={t("tenantOperations.performance")}
        >
          <p>
            {t("tenantOperations.monthScope")}
            {activeTab === "agents" ? (
              <> · {t("tenantOperations.agentScope")}</>
            ) : null}
          </p>
          <dl>
            {(activeTab === "agents"
              ? ([
                  ["agentEvents", insights.agentEvents],
                  ["agentTokens", insights.agentTokens],
                ] as const)
              : ([
                  ["recordedRuns", insights.flowRuns],
                  ["flowSuccess", insights.flowSucceeded],
                  ["flowFailed", insights.flowFailed],
                ] as const)
            ).map(([key, value]) => (
              <div key={key}>
                <dt>{t(`tenantOperations.${key}`)}</dt>
                <dd>{value.toLocaleString(locale)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      <Tabs
        activeId={activeTab}
        ariaLabel={t("orchestration.agents")}
        direction={locale === "he" ? "rtl" : "ltr"}
        items={[
          {
            count: agents.length,
            id: "agents",
            controls: "orchestration-agents-panel",
            tabId: "orchestration-agents-tab",
            label: t("orchestration.agents"),
          },
          {
            count: flows.length,
            id: "flows",
            controls: "orchestration-flows-panel",
            tabId: "orchestration-flows-tab",
            label: t("orchestration.flows"),
          },
          {
            count: activity.length,
            id: "activity",
            controls: "orchestration-activity-panel",
            tabId: "orchestration-activity-tab",
            label: `${t("operations.runs")} / ${t("orchestration.activity")}`,
          },
          {
            count: handoffs.length,
            id: "handoffs",
            controls: "orchestration-handoffs-panel",
            tabId: "orchestration-handoffs-tab",
            label: t("orchestration.handoffs"),
          },
        ]}
        onChange={selectTab}
      />

      <section
        aria-labelledby="orchestration-agents-tab"
        id="orchestration-agents-panel"
        className="orchestration-workspace__panel"
        hidden={activeTab !== "agents"}
        role="tabpanel"
      >
        <Surface
          className="orchestration-index orchestration-agent-library"
          level="raised"
        >
          <header className="orchestration-index__header">
            <div>
              <h2>{t("orchestration.agents")}</h2>
              <p className="feature-copy">{t("orchestration.agentsHint")}</p>
            </div>
            {!canEdit ? (
              <Badge label={t("common.readOnly")} tone="neutral" />
            ) : null}
            <Button
              disabled={!canEdit}
              onClick={() => openCreation("agents")}
              size="small"
            >
              <Plus aria-hidden="true" size={16} />
              {t("orchestration.draft")}
            </Button>
          </header>

          {agents.length === 0 ? (
            <EmptyState
              title={t("orchestration.emptyAgentsTitle")}
              description={t(
                canEdit
                  ? "orchestration.emptyAgentsDescription"
                  : "orchestration.emptyReadOnly",
              )}
              action={
                canEdit ? (
                  <Button
                    onClick={() => openCreation("agents")}
                    variant="secondary"
                  >
                    {t("orchestration.startAgent")}
                  </Button>
                ) : undefined
              }
            />
          ) : null}
          {agents.length ? (
            <AgentRegister
              agents={agents}
              canEdit={canEdit}
              pending={pending}
              publish={(id) =>
                void run(() =>
                  crmMutation(`/api/orchestration/agents/${id}/publish`, {}),
                )
              }
              rename={(id, name) =>
                run(() =>
                  crmMutation(
                    `/api/orchestration/agents/${id}`,
                    { name },
                    { method: "PATCH" },
                  ),
                )
              }
              remove={(id) =>
                run(() =>
                  crmMutation(
                    `/api/orchestration/agents/${id}`,
                    {},
                    { method: "DELETE" },
                  ),
                )
              }
              setDefault={(id) =>
                run(() =>
                  crmMutation(
                    `/api/orchestration/agents/${id}`,
                    { defaultWhatsApp: true },
                    { method: "PATCH" },
                  ),
                )
              }
            />
          ) : null}

          <Dialog
            className="orchestration-create-dialog"
            open={creation === "agents"}
            onClose={() => setCreation(null)}
            closeLabel={t("common.close")}
            title={t("orchestration.draft")}
          >
            <form
              className="feature-form operation-create-disclosure__form"
              onSubmit={(event) => void createAgent(event)}
            >
              <fieldset
                className="form-fieldset"
                disabled={pending || !canEdit}
              >
                {!canEdit ? (
                  <p className="public-note">{t("common.readOnly")}</p>
                ) : null}
                <Input
                  id="agent-name"
                  data-dialog-initial-focus
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
                <Textarea
                  id="agent-prompt"
                  label={t("orchestration.prompt")}
                  name="systemPrompt"
                  required
                  rows={4}
                />
                <Button busy={pending} disabled={!canEdit} type="submit">
                  {t("orchestration.draft")}
                </Button>
              </fieldset>
            </form>
            {error && creation === "agents" ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
          </Dialog>
        </Surface>
      </section>

      <section
        aria-labelledby="orchestration-flows-tab"
        id="orchestration-flows-panel"
        className="orchestration-workspace__panel"
        hidden={activeTab !== "flows"}
        role="tabpanel"
      >
        <Surface
          className="orchestration-index orchestration-flow-library"
          level="raised"
        >
          <header className="orchestration-index__header">
            <div>
              <h2>{t("orchestration.flows")}</h2>
              <p className="feature-copy">{t("orchestration.flowsHint")}</p>
            </div>
            {!canEdit ? (
              <Badge label={t("common.readOnly")} tone="neutral" />
            ) : null}
            <Button
              disabled={!canEdit}
              onClick={() => openCreation("flows")}
              size="small"
            >
              <GitBranch aria-hidden="true" size={16} />
              {t("orchestration.createFlow")}
            </Button>
          </header>

          {flows.length === 0 ? (
            <EmptyState
              title={t("orchestration.emptyFlowsTitle")}
              description={t(
                canEdit
                  ? "orchestration.emptyFlowsDescription"
                  : "orchestration.emptyReadOnly",
              )}
              action={
                canEdit ? (
                  <Button
                    onClick={() =>
                      hasPublishedAgent
                        ? openCreation("flows")
                        : selectTab("agents")
                    }
                    variant="secondary"
                  >
                    {t(
                      hasPublishedAgent
                        ? "orchestration.startFlow"
                        : "orchestration.reviewAgents",
                    )}
                  </Button>
                ) : undefined
              }
            />
          ) : null}
          <div className="tenant-register-toolbar">
            <Input
              id="connected-flow-search"
              type="search"
              label={t("tenantOperations.search")}
              value={flowQuery}
              onChange={(event) => setFlowQuery(event.target.value)}
            />
          </div>
          {selectedFlow === undefined ? null : (
            <div className="orchestration-flow-studio">
              <nav
                aria-label={t("orchestration.flowLibrary")}
                className="orchestration-flow-studio__library"
              >
                {filteredFlows.length === 0 ? (
                  <p className="tenant-no-results">
                    {t("tenantOperations.noMatches")}
                  </p>
                ) : null}
                {filteredFlows.map((flow) => (
                  <button
                    aria-current={
                      flow.id === selectedFlow.id ? "true" : undefined
                    }
                    className="orchestration-flow-studio__flow"
                    key={flow.id}
                    onClick={() => setSelectedFlowId(flow.id)}
                    type="button"
                  >
                    <span>
                      <strong>{flow.name}</strong>
                      <small>
                        {t("common.version", { version: flow.version })}
                      </small>
                    </span>
                    <span
                      aria-hidden="true"
                      className={`orchestration-flow-studio__state orchestration-flow-studio__state--${flow.published ? "published" : "draft"}`}
                    />
                  </button>
                ))}
              </nav>
              <section
                aria-label={t("orchestration.flowPreview", {
                  name: selectedFlow.name,
                })}
                className="orchestration-flow-studio__workspace"
              >
                <header className="orchestration-flow-card__header">
                  <div className="orchestration-index__identity">
                    <strong>{selectedFlow.name}</strong>
                    <p>
                      {t("common.version", { version: selectedFlow.version })}
                    </p>
                  </div>
                  <Badge
                    label={t(
                      selectedFlow.published
                        ? "status.published"
                        : "status.draft",
                    )}
                    tone={selectedFlow.published ? "positive" : "neutral"}
                  />
                  <div className="tenant-register-heading__actions">
                    {selectedFlow.executionKind !== "canonical" ? (
                      <Link className="text-link" href="/operations">
                        {t("operations.automations")}
                      </Link>
                    ) : !selectedFlow.published ? (
                      <Button
                        busy={pending}
                        disabled={!canEdit}
                        onClick={() =>
                          void run(() =>
                            crmMutation(
                              `/api/orchestration/flows/${selectedFlow.id}/publish`,
                              {},
                            ),
                          )
                        }
                        size="small"
                        variant="quiet"
                      >
                        {t("orchestration.publish")}
                      </Button>
                    ) : null}
                    <Button
                      disabled={!canEdit || pending}
                      onClick={() => setRenameFlowId(selectedFlow.id)}
                      size="small"
                      variant="quiet"
                    >
                      <Pencil aria-hidden="true" size={15} />
                      {t("common.rename")}
                    </Button>
                    <Button
                      disabled={!canEdit || pending}
                      onClick={() => setDeleteFlowId(selectedFlow.id)}
                      size="small"
                      variant="quiet"
                    >
                      <Trash2 aria-hidden="true" size={15} />
                      {t("common.delete")}
                    </Button>
                  </div>
                </header>

                <FlowCanvas
                  ariaLabel={t("orchestration.flowCanvas", {
                    name: selectedFlow.name,
                  })}
                  definition={selectedFlow.definition}
                  emptyLabel={t("orchestration.flowCanvasEmpty")}
                  labelForType={(type) => {
                    const key = nodeTypeTranslationKeys[type];
                    return key === undefined ? type : t(key);
                  }}
                />

                <details className="tenant-history-disclosure">
                  <summary>{t("tenantOperations.runHistory")}</summary>
                  <AutomationRunHistory
                    key={selectedFlow.id}
                    definitionId={selectedFlow.id}
                    flows={flows}
                    runs={runs}
                  />
                </details>

                {selectedFlow.published &&
                selectedFlow.executionKind === "canonical" ? (
                  <details className="orchestration-index__inline-disclosure">
                    <summary>{t("orchestration.queueFlow")}</summary>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        void run(() =>
                          crmMutation(
                            `/api/orchestration/flows/${selectedFlow.id}/simulate`,
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
                        <Select
                          id={`flow-conversation-${selectedFlow.id}`}
                          label={t("orchestration.conversation")}
                          name="conversationId"
                          required
                        >
                          {conversations.map((conversation) => (
                            <option
                              key={conversation.id}
                              value={conversation.id}
                            >
                              {conversation.contactName}
                            </option>
                          ))}
                        </Select>
                        <Select
                          id={`flow-channel-${selectedFlow.id}`}
                          label={t("orchestration.channel")}
                          name="channel"
                        >
                          <option value="voice">
                            {t("orchestration.voice")}
                          </option>
                          <option value="whatsapp">
                            {t("orchestration.whatsapp")}
                          </option>
                        </Select>
                        <Button
                          busy={pending}
                          disabled={!canEdit || conversations.length === 0}
                          size="small"
                          type="submit"
                        >
                          {t("orchestration.queueFlow")}
                        </Button>
                        <p>{t("orchestration.flowHint")}</p>
                      </fieldset>
                    </form>
                  </details>
                ) : null}
              </section>
            </div>
          )}

          <Dialog
            className="orchestration-create-dialog"
            open={creation === "flows"}
            onClose={() => setCreation(null)}
            closeLabel={t("common.close")}
            title={t("orchestration.createFlow")}
          >
            <form
              className="feature-form operation-create-disclosure__form"
              onSubmit={(event) => void createFlow(event)}
            >
              <fieldset
                className="form-fieldset"
                disabled={pending || !canEdit}
              >
                {!canEdit ? (
                  <p className="public-note">{t("common.readOnly")}</p>
                ) : null}
                <Input
                  id="flow-name"
                  data-dialog-initial-focus
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
                  defaultValue="1"
                  id="flow-voice-version"
                  label={t("orchestration.flowVersion")}
                  min="1"
                  name="voiceFlowVersion"
                  required
                  type="number"
                />
                <Select
                  id="flow-agent"
                  label={t("orchestration.whatsappAgentVersion")}
                  name="agentProfileVersionId"
                  required
                >
                  <option value="">{t("orchestration.selectAgent")}</option>
                  {agents
                    .filter(
                      (agent) =>
                        agent.published &&
                        agent.versionId &&
                        agent.channels.includes("whatsapp"),
                    )
                    .map((agent) => (
                      <option key={agent.id} value={agent.versionId ?? ""}>
                        {agent.name} · v{agent.version}
                      </option>
                    ))}
                </Select>
                <Select
                  id="flow-voice-agent"
                  label={t("orchestration.voiceAgentVersion")}
                  name="voiceAgentProfileVersionId"
                  required
                >
                  <option value="">
                    {t("orchestration.selectVoiceAgent")}
                  </option>
                  {agents
                    .filter(
                      (agent) =>
                        agent.published &&
                        agent.versionId &&
                        agent.channels.includes("voice"),
                    )
                    .map((agent) => (
                      <option key={agent.id} value={agent.versionId ?? ""}>
                        {agent.name} · v{agent.version}
                      </option>
                    ))}
                </Select>
                <Button
                  busy={pending}
                  disabled={!canEdit}
                  type="submit"
                  variant="secondary"
                >
                  {t("orchestration.createFlow")}
                </Button>
              </fieldset>
            </form>
            {error && creation === "flows" ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
          </Dialog>
          <Dialog
            closeLabel={t("common.close")}
            onClose={() => setRenameFlowId(undefined)}
            open={renameFlowId !== undefined}
            title={t("orchestration.renameFlow")}
          >
            <form
              className="feature-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (renameFlowId === undefined) return;
                const data = new FormData(event.currentTarget);
                const name = data.get("name");
                if (typeof name !== "string") return;
                void run(() =>
                  crmMutation(
                    `/api/orchestration/flows/${renameFlowId}`,
                    { name },
                    { method: "PATCH" },
                  ),
                ).then((renamed) => {
                  if (renamed) setRenameFlowId(undefined);
                });
              }}
            >
              <Input
                data-dialog-initial-focus
                defaultValue={
                  flows.find(({ id }) => id === renameFlowId)?.name ?? ""
                }
                id="rename-flow-name"
                label={t("orchestration.flowName")}
                maxLength={120}
                name="name"
                required
              />
              <Button busy={pending} type="submit">
                {t("common.save")}
              </Button>
            </form>
          </Dialog>
          <ConfirmDialog
            busy={pending}
            cancelLabel={t("common.cancel")}
            confirmLabel={t("orchestration.deleteFlow")}
            description={t("orchestration.deleteFlowHint")}
            destructive
            onCancel={() => setDeleteFlowId(undefined)}
            onConfirm={() => {
              if (deleteFlowId === undefined) return;
              void run(() =>
                crmMutation(
                  `/api/orchestration/flows/${deleteFlowId}`,
                  {},
                  { method: "DELETE" },
                ),
              ).then((removed) => {
                if (removed) setDeleteFlowId(undefined);
              });
            }}
            open={deleteFlowId !== undefined}
            title={t("orchestration.deleteFlowTitle")}
          />
        </Surface>
      </section>

      <section
        aria-labelledby="orchestration-activity-tab"
        id="orchestration-activity-panel"
        className="orchestration-workspace__panel orchestration-activity"
        hidden={activeTab !== "activity"}
        role="tabpanel"
      >
        <div
          aria-label={t("orchestration.usage")}
          className="orchestration-usage-inspector"
          role="group"
        >
          <div>
            <p className="eyebrow">{t("orchestration.usage")}</p>
            <h2>{t("premiumVoice.tenantUsage")}</h2>
            <p>{t("premiumVoice.usageHint")}</p>
          </div>
          <Metric
            label={t("orchestration.events")}
            value={usage.agentEvents.toLocaleString(locale)}
          />
          <Metric
            label={t("orchestration.tokens")}
            value={(usage.inputTokens + usage.outputTokens).toLocaleString(
              locale,
            )}
          />
          <Metric
            label={t("orchestration.sessions")}
            value={usage.voiceSessions.toLocaleString(locale)}
          />
          <Metric
            detail={
              usage.unpricedEvents > 0
                ? t("orchestration.unpriced")
                : t("orchestration.noUsage")
            }
            label={t("orchestration.latency")}
            value={
              usage.averageLatencyMs === null
                ? t("orchestration.noLatency")
                : `${usage.averageLatencyMs.toLocaleString(locale)} ms`
            }
          />
          <div className="orchestration-token-split">
            <span>{t("premiumVoice.inputTokens")}</span>
            <strong>{usage.inputTokens.toLocaleString(locale)}</strong>
            <meter
              aria-label={t("premiumVoice.inputTokens")}
              min={0}
              max={usage.inputTokens + usage.outputTokens || 1}
              value={usage.inputTokens}
            />
            <span>{t("premiumVoice.outputTokens")}</span>
            <strong>{usage.outputTokens.toLocaleString(locale)}</strong>
            <meter
              aria-label={t("premiumVoice.outputTokens")}
              min={0}
              max={usage.inputTokens + usage.outputTokens || 1}
              value={usage.outputTokens}
            />
          </div>
        </div>

        <Surface
          className="orchestration-index orchestration-event-journal"
          level="raised"
        >
          <header className="orchestration-index__header">
            <div>
              <h2>{t("orchestration.activity")}</h2>
              <p className="feature-copy">
                {t("orchestration.simulationHint")}
              </p>
            </div>
            <Button
              disabled={!canEdit}
              onClick={() => setCreation("simulation")}
              size="small"
              variant="secondary"
            >
              {t("orchestration.simulations")}
            </Button>
          </header>

          {contacts.length ? (
            <form action="/orchestration" className="feature-toolbar">
              <input type="hidden" name="tab" value="activity" />
              <Combobox
                {...(activityContactId
                  ? { defaultValue: activityContactId }
                  : {})}
                id="activity-contact"
                label={t("orchestration.contact")}
                name="contact"
                options={contacts.map((contact) => ({
                  value: contact.id,
                  label: contact.name,
                }))}
                searchLabel={t("premiumVoice.searchContacts")}
                emptyLabel={t("premiumVoice.noMatchingContacts")}
              />
              <Button size="small" type="submit" variant="secondary">
                {t("common.details")}
              </Button>
            </form>
          ) : null}
          {activity.length === 0 ? (
            <p className="public-note">{t("orchestration.none")}</p>
          ) : null}
          <ol className="timeline orchestration-activity__timeline">
            {activity.map((item) => (
              <li key={`${item.sourceType}-${item.eventId}`}>
                <div>
                  <strong>{activityLabel(item.eventType, t)}</strong>
                  <time dateTime={item.occurredAt}>
                    {dateTime.format(new Date(item.occurredAt))}
                  </time>
                </div>
                <details className="technical-details">
                  <summary>{t("contacts.technical")}</summary>
                  <code dir="ltr">{item.eventType}</code>
                  <pre>{JSON.stringify(item.metadata, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ol>

          <Dialog
            className="orchestration-create-dialog"
            open={creation === "simulation"}
            onClose={() => setCreation(null)}
            closeLabel={t("common.close")}
            title={t("orchestration.simulations")}
          >
            <p className="feature-copy">{t("orchestration.simulationHint")}</p>
            <form
              className="feature-form operation-create-disclosure__form"
              onSubmit={(event) => void simulate(event)}
            >
              <fieldset
                className="form-fieldset"
                disabled={pending || !canEdit}
              >
                {!canEdit ? (
                  <p className="public-note">{t("common.readOnly")}</p>
                ) : null}
                <Select
                  id="simulation-kind"
                  label={t("orchestration.workflow")}
                  name="kind"
                >
                  <option value="call-outcome-whatsapp">
                    {t("orchestration.callFollowup")}
                  </option>
                  <option value="whatsapp-crm-call">
                    {t("tenantOperations.messageCall")}
                  </option>
                </Select>
                <Select
                  id="simulation-session"
                  label={t("orchestration.outcome")}
                  name="sessionId"
                >
                  <option value="">{t("orchestration.selectCall")}</option>
                  {voiceOutcomes.map((outcome) => (
                    <option key={outcome.sessionId} value={outcome.sessionId}>
                      {outcome.outcome} · {outcome.sessionId.slice(0, 8)}
                    </option>
                  ))}
                </Select>
                <Select
                  id="simulation-conversation"
                  label={t("orchestration.conversationLabel")}
                  name="conversationId"
                >
                  <option value="">{t("orchestration.notRequired")}</option>
                  {conversations.map((conversation) => (
                    <option key={conversation.id} value={conversation.id}>
                      {conversation.contactName}
                    </option>
                  ))}
                </Select>
                <Button
                  busy={pending}
                  disabled={
                    !canEdit ||
                    (voiceOutcomes.length === 0 && conversations.length === 0)
                  }
                  type="submit"
                >
                  {t("orchestration.queue")}
                </Button>
              </fieldset>
            </form>
            {error && creation === "simulation" ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
          </Dialog>
        </Surface>
      </section>

      <section
        aria-labelledby="orchestration-handoffs-tab"
        id="orchestration-handoffs-panel"
        className="orchestration-workspace__panel"
        hidden={activeTab !== "handoffs"}
        role="tabpanel"
      >
        <Surface
          className="orchestration-index orchestration-handoff-workspace"
          level="raised"
        >
          <header className="orchestration-index__header">
            <h2>{t("orchestration.handoffs")}</h2>
            {!canHandoff ? (
              <Badge label={t("common.readOnly")} tone="neutral" />
            ) : null}
            <Button
              disabled={!canHandoff}
              onClick={() => setCreation("handoff")}
              size="small"
            >
              <Plus aria-hidden="true" size={16} />
              {t("orchestration.request")}
            </Button>
          </header>

          <div className="orchestration-handoff-queue">
            {[...handoffs]
              .sort(
                (a, b) =>
                  Number(a.status === "resolved" || a.status === "cancelled") -
                  Number(b.status === "resolved" || b.status === "cancelled"),
              )
              .map((handoff) => (
                <article
                  className="orchestration-handoff-item"
                  data-status={handoff.status}
                  key={handoff.id}
                >
                  <span
                    className="orchestration-handoff-item__signal"
                    aria-hidden="true"
                  >
                    <Headphones size={20} />
                  </span>
                  <div className="orchestration-index__identity">
                    <Link
                      href={`/contacts/${handoff.contactId}`}
                      className="text-link"
                    >
                      <bdi>
                        {contacts.find(
                          (contact) => contact.id === handoff.contactId,
                        )?.name ?? handoff.contactId.slice(0, 8)}
                      </bdi>
                    </Link>
                    <strong>{handoff.reasonSafe}</strong>
                    <p>
                      {handoff.sourceChannel} ·{" "}
                      {dateTime.format(new Date(handoff.requestedAt))}
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
                      busy={pending}
                      disabled={!canHandoff}
                      onClick={() =>
                        void run(() =>
                          crmMutation(
                            `/api/orchestration/handoffs/${handoff.id}`,
                            { action: "accept" },
                            { method: "PATCH" },
                          ),
                        )
                      }
                      size="small"
                      variant="quiet"
                    >
                      {t("orchestration.accept")}
                    </Button>
                  ) : handoff.status === "accepted" ? (
                    <Button
                      busy={pending}
                      disabled={!canHandoff}
                      onClick={() =>
                        void run(() =>
                          crmMutation(
                            `/api/orchestration/handoffs/${handoff.id}`,
                            { action: "resolve" },
                            { method: "PATCH" },
                          ),
                        )
                      }
                      size="small"
                      variant="quiet"
                    >
                      {t("orchestration.resolve")}
                    </Button>
                  ) : null}
                </article>
              ))}
          </div>

          {handoffs.length === 0 ? (
            <EmptyState
              title={t("premiumVoice.noHandoffs")}
              description={t("premiumVoice.noHandoffsHint")}
            />
          ) : null}
          <p className="orchestration-scope-note">
            {t("premiumVoice.handoffScope")}
          </p>
          <Dialog
            className="orchestration-create-dialog"
            open={creation === "handoff"}
            onClose={() => setCreation(null)}
            closeLabel={t("common.close")}
            title={t("orchestration.request")}
          >
            <form
              className="feature-form operation-create-disclosure__form"
              onSubmit={(event) => void createHandoff(event)}
            >
              <fieldset
                className="form-fieldset"
                disabled={pending || !canHandoff}
              >
                {!canHandoff ? (
                  <p className="public-note">{t("common.readOnly")}</p>
                ) : null}
                <Combobox
                  id="handoff-contact"
                  label={t("orchestration.whatsappConversation")}
                  name="contactId"
                  required
                  options={Array.from(
                    new Map(
                      conversations.map((conversation) => [
                        conversation.contactId,
                        {
                          value: conversation.contactId,
                          label: conversation.contactName,
                        },
                      ]),
                    ).values(),
                  )}
                  searchLabel={t("premiumVoice.searchContacts")}
                  emptyLabel={t("premiumVoice.noMatchingContacts")}
                />
                <Input
                  id="handoff-reason"
                  label={t("orchestration.handoffReason")}
                  name="reasonSafe"
                  required
                />
                <Button
                  busy={pending}
                  disabled={!canHandoff || conversations.length === 0}
                  type="submit"
                >
                  {t("orchestration.request")}
                </Button>
              </fieldset>
            </form>
            {error && creation === "handoff" ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
          </Dialog>
        </Surface>
      </section>

      {error === undefined || creation !== null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
