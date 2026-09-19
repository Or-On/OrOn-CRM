"use client";

import { useState, type SyntheticEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AgentProfileSummary } from "@or-on/crm";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  Input,
  Select,
  Textarea,
} from "@or-on/ui";
import { Bot, FilePenLine, Pencil, Sparkles, Trash2 } from "lucide-react";
import { AgentCapabilityReview } from "./agent-capability-review";
import { capabilityCopy } from "./agent-capability-copy";
import { AgentQualityWorkspace } from "./agent-quality-workspace";
import {
  emptyLeadConfiguration,
  LeadCapabilityFieldset,
  leadRequestFields,
  type LeadCapabilityConfiguration,
} from "./lead-capability-fieldset";
import { qualityCopy } from "./quality-copy";

/** The fields a revision sends, built from the operator's explicit choices. */
export type AgentRevision = Record<string, unknown>;

export function AgentRegister({
  agents,
  canEdit,
  pending,
  publish,
  rename = () => Promise.resolve(false),
  remove = () => Promise.resolve(false),
  setDefault = () => Promise.resolve(false),
  rebind = () => Promise.resolve(false),
  revise = () => Promise.resolve(false),
}: {
  readonly agents: readonly AgentProfileSummary[];
  readonly canEdit: boolean;
  readonly pending: boolean;
  readonly publish: (id: string) => void;
  readonly rename?: (id: string, name: string) => Promise<boolean>;
  readonly remove?: (id: string) => Promise<boolean>;
  readonly setDefault?: (id: string) => Promise<boolean>;
  readonly rebind?: (id: string, versionId: string) => Promise<boolean>;
  readonly revise?: (id: string, revision: AgentRevision) => Promise<boolean>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const capabilityText = capabilityCopy(locale);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState(agents[0]?.id);
  const [qualityId, setQualityId] = useState<string>();
  const [renameId, setRenameId] = useState<string>();
  const [deleteId, setDeleteId] = useState<string>();
  const [reviseId, setReviseId] = useState<string>();
  const [revisePrompt, setRevisePrompt] = useState("");
  const [reviseLeads, setReviseLeads] = useState<LeadCapabilityConfiguration>(
    emptyLeadConfiguration(),
  );
  const [reviseError, setReviseError] = useState<string>();

  function openRevision(agent: AgentProfileSummary) {
    setRevisePrompt(agent.systemPrompt ?? "");
    setReviseLeads(
      emptyLeadConfiguration({
        // A version published before capabilities existed opened tickets on
        // escalation; its next draft keeps that only because the box starts
        // ticked, where the operator can see and change it.
        capabilities: [
          ...agent.capabilities.filter((entry) => entry !== "lead.read"),
          ...(agent.implicitTicketing &&
          !agent.capabilities.includes("ticket.open")
            ? (["ticket.open"] as const)
            : []),
        ],
        roleTitle: agent.roleTitle ?? "",
        ...(agent.leadFieldSchemaId === null
          ? {}
          : {
              schemaMode: "existing" as const,
              schemaId: agent.leadFieldSchemaId,
            }),
      }),
    );
    setReviseError(undefined);
    setReviseId(agent.id);
  }

  async function submitRevision(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const agent = agents.find(({ id }) => id === reviseId);
    if (agent?.versionId === null || agent === undefined) return;
    try {
      const leads = await leadRequestFields(reviseLeads);
      const saved = await revise(agent.id, {
        systemPrompt: revisePrompt,
        baseVersionId: agent.versionId,
        channels: agent.channels,
        ...(agent.locale ? { locale: agent.locale } : {}),
        ...leads,
      });
      if (saved) setReviseId(undefined);
    } catch {
      setReviseError(capabilityText.failed);
    }
  }
  const visible = agents.filter(
    (agent) =>
      (status === "all" ||
        (agent.published ? "published" : "draft") === status) &&
      `${agent.name} ${agent.description ?? ""}`
        .toLocaleLowerCase(locale)
        .includes(query.trim().toLocaleLowerCase(locale)),
  );
  const selected =
    visible.find((agent) => agent.id === selectedId) ?? visible[0];

  async function submitRename(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (renameId === undefined) return;
    const data = new FormData(event.currentTarget);
    const name = data.get("name");
    if (typeof name !== "string") return;
    if (await rename(renameId, name)) setRenameId(undefined);
  }
  return (
    <>
      <div className="tenant-register-toolbar">
        <Input
          id="agent-search"
          type="search"
          label={t("tenantOperations.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          id="agent-status"
          label={t("inbox.status")}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="all">{t("tenantOperations.allStates")}</option>
          <option value="published">{t("status.published")}</option>
          <option value="draft">{t("status.draft")}</option>
        </Select>
        <p role="status">
          {t("tenantOperations.showing", {
            count: visible.length,
            total: agents.length,
          })}
        </p>
      </div>
      <div className="tenant-agent-manager">
        <nav
          className="tenant-record-list"
          aria-label={t("orchestration.agents")}
        >
          {visible.length ? (
            visible.map((agent) => (
              <button
                type="button"
                key={agent.id}
                aria-current={selected?.id === agent.id ? "true" : undefined}
                onClick={() => setSelectedId(agent.id)}
              >
                <span>
                  <strong dir="auto">{agent.name}</strong>
                  <small>
                    {agent.channels.join(" · ") || t("common.notSet")}
                  </small>
                </span>
                <Badge
                  label={t(
                    agent.published ? "status.published" : "status.draft",
                  )}
                  tone={agent.published ? "positive" : "neutral"}
                />
              </button>
            ))
          ) : (
            <p className="tenant-no-results">
              {t("tenantOperations.noMatches")}
            </p>
          )}
        </nav>
        {selected ? (
          <section
            className="tenant-agent-inspector"
            aria-label={t("tenantOperations.agentConfiguration")}
          >
            <header className="tenant-register-heading">
              <div>
                <h3 dir="auto">
                  <Bot aria-hidden="true" size={17} />
                  {selected.name}
                </h3>
                <p>
                  {t(
                    selected.published
                      ? "tenantOperations.publishedHint"
                      : "tenantOperations.draftHint",
                  )}
                </p>
              </div>
              <div className="tenant-register-heading__actions">
                {!selected.published ? (
                  <Button
                    busy={pending}
                    disabled={!canEdit || selected.validationStatus !== "valid"}
                    size="small"
                    variant="secondary"
                    onClick={() => publish(selected.id)}
                  >
                    {t("orchestration.publish")}
                  </Button>
                ) : null}
                {selected.published &&
                selected.channels.includes("whatsapp") ? (
                  <Button
                    disabled={!canEdit || pending || selected.isDefaultWhatsApp}
                    onClick={() => void setDefault(selected.id)}
                    size="small"
                    variant="quiet"
                  >
                    <Sparkles aria-hidden="true" size={15} />
                    {t(
                      selected.isDefaultWhatsApp
                        ? "orchestration.defaultAgent"
                        : "orchestration.makeDefaultAgent",
                    )}
                  </Button>
                ) : null}
                <Button
                  disabled={!canEdit || pending || selected.versionId === null}
                  onClick={() => openRevision(selected)}
                  size="small"
                  variant="quiet"
                >
                  <FilePenLine aria-hidden="true" size={15} />
                  {capabilityText.revise}
                </Button>
                <Button
                  disabled={!canEdit || pending}
                  onClick={() => setRenameId(selected.id)}
                  size="small"
                  variant="quiet"
                >
                  <Pencil aria-hidden="true" size={15} />
                  {t("common.rename")}
                </Button>
                <Button
                  disabled={!canEdit || pending}
                  onClick={() => setDeleteId(selected.id)}
                  size="small"
                  variant="quiet"
                >
                  <Trash2 aria-hidden="true" size={15} />
                  {t("common.delete")}
                </Button>
              </div>
            </header>
            {selected.description ? (
              <p dir="auto">{selected.description}</p>
            ) : null}
            <dl className="tenant-definition-list">
              <div>
                <dt>{t("common.version", { version: "" })}</dt>
                <dd>{selected.version ?? "—"}</dd>
              </div>
              <div>
                <dt>{t("management.locale")}</dt>
                <dd>
                  <bdi>{selected.locale ?? t("common.notSet")}</bdi>
                </dd>
              </div>
              <div>
                <dt>{t("tenantOperations.channels")}</dt>
                <dd>{selected.channels.join(" · ") || t("common.notSet")}</dd>
              </div>
              <div>
                <dt>{t("inbox.status")}</dt>
                <dd>
                  {selected.validationStatus
                    ? t(`status.${selected.validationStatus}`)
                    : t("common.notSet")}
                </dd>
              </div>
            </dl>
            <AgentCapabilityReview
              agent={selected}
              canEdit={canEdit}
              pending={pending}
              rebind={(versionId) => void rebind(selected.id, versionId)}
            />
            <section className="tenant-agent-instructions">
              <h4>{t("tenantOperations.instructions")}</h4>
              <p dir="auto">
                {selected.systemPrompt?.trim()
                  ? selected.systemPrompt
                  : t("tenantOperations.noInstructions")}
              </p>
            </section>
            {canEdit ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => setQualityId(selected.id)}
                >
                  {qualityCopy(locale).open}
                </Button>
                {qualityId === selected.id ? (
                  <AgentQualityWorkspace
                    key={selected.id}
                    profileId={selected.id}
                  />
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}
      </div>
      <Dialog
        closeLabel={t("common.close")}
        onClose={() => setRenameId(undefined)}
        open={renameId !== undefined}
        title={t("orchestration.renameAgent")}
      >
        <form
          className="feature-form"
          onSubmit={(event) => void submitRename(event)}
        >
          <Input
            data-dialog-initial-focus
            defaultValue={agents.find(({ id }) => id === renameId)?.name ?? ""}
            id="rename-agent-name"
            label={t("orchestration.agentName")}
            maxLength={120}
            name="name"
            required
          />
          <Button busy={pending} type="submit">
            {t("common.save")}
          </Button>
        </form>
      </Dialog>
      <Dialog
        closeLabel={t("common.close")}
        onClose={() => setReviseId(undefined)}
        open={reviseId !== undefined}
        title={capabilityText.reviseTitle}
      >
        <form
          className="feature-form"
          onSubmit={(event) => void submitRevision(event)}
        >
          <p>{capabilityText.reviseHint}</p>
          <Textarea
            data-dialog-initial-focus
            dir="auto"
            id="revise-agent-prompt"
            label={t("tenantOperations.instructions")}
            maxLength={16000}
            required
            rows={10}
            value={revisePrompt}
            onChange={(event) => setRevisePrompt(event.target.value)}
          />
          <LeadCapabilityFieldset
            idPrefix="revise-agent"
            value={reviseLeads}
            onChange={setReviseLeads}
            disabled={pending}
          />
          {reviseError === undefined ? null : <p role="alert">{reviseError}</p>}
          <Button busy={pending} type="submit">
            {t("common.save")}
          </Button>
        </form>
      </Dialog>
      <ConfirmDialog
        busy={pending}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("orchestration.deleteAgent")}
        description={t("orchestration.deleteAgentHint")}
        destructive
        onCancel={() => setDeleteId(undefined)}
        onConfirm={() => {
          if (deleteId === undefined) return;
          void remove(deleteId).then((removed) => {
            if (removed) setDeleteId(undefined);
          });
        }}
        open={deleteId !== undefined}
        title={t("orchestration.deleteAgentTitle")}
      />
    </>
  );
}
