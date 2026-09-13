"use client";

import type { ComponentCatalog, FlowSummary } from "@or-on/api-client";
import {
  Badge,
  Button,
  Dialog,
  Surface,
  Textarea,
  Input,
  Select,
} from "@or-on/ui";
import { Braces, Plus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { errorMessage } from "../../i18n/error-message";
import { useCapability } from "../access";
import { voiceMutation } from "./mutation";

interface FlowFeedback {
  readonly kind: "error" | "success";
  readonly text: string;
}

export function VoiceFlowPanel({
  catalog,
  flows,
}: {
  readonly catalog: ComponentCatalog;
  readonly flows: readonly FlowSummary[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const canEdit = useCapability("voice:operate");
  const router = useRouter();
  const [editorOpen, setEditorOpen] = useState(false);
  const [source, setSource] = useState("");
  const [feedback, setFeedback] = useState<FlowFeedback>();
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [language, setLanguage] = useState("all");
  const [selectedId, setSelectedId] = useState(flows[0]?.flow_id);
  const visible = flows.filter(
    (flow) =>
      (sourceFilter === "all" ||
        (flow.packaged ? "packaged" : "tenant") === sourceFilter) &&
      (language === "all" || flow.language === language) &&
      `${flow.name} ${flow.flow_id}`
        .toLocaleLowerCase(locale)
        .includes(query.trim().toLocaleLowerCase(locale)),
  );
  const selected =
    visible.find((flow) => flow.flow_id === selectedId) ?? visible[0];

  async function act(path: string) {
    setPending(true);
    setFeedback(undefined);
    try {
      const parsed: unknown = JSON.parse(source);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      )
        throw new TypeError(t("voice.sourceInvalid"));
      const result = (await voiceMutation(path, { source: parsed })) as {
        valid?: boolean;
        errors?: string[];
      };
      if (result.valid === false) {
        setFeedback({
          kind: "error",
          text: result.errors?.join("; ") ?? t("voice.flowFailed"),
        });
      } else {
        setFeedback({
          kind: "success",
          text: path.endsWith("publish")
            ? t("voice.published")
            : t("voice.valid"),
        });
        router.refresh();
      }
    } catch (error) {
      setFeedback({
        kind: "error",
        text: errorMessage(error, t, "voice.flowFailed"),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="voice-flow-workspace">
      <Surface className="voice-detail-index" level="raised">
        <header className="voice-detail-index__header">
          <div>
            <p className="eyebrow">{t("voice.adapter")}</p>
            <h2>{t("voice.catalog")}</h2>
            <p>{t("voice.components", { count: catalog.components.length })}</p>
          </div>
          <div className="voice-detail-index__actions">
            {!canEdit ? (
              <Badge label={t("common.readOnly")} tone="neutral" />
            ) : null}
            <Badge
              label={t("voice.catalogVersion", {
                version: catalog.spec_version,
              })}
              tone="info"
            />
            <Button
              aria-controls="flow-source"
              aria-expanded={editorOpen}
              disabled={!canEdit}
              onClick={() => setEditorOpen((open) => !open)}
              size="small"
            >
              <Plus aria-hidden="true" size={15} />
              {t("voice.source")}
            </Button>
          </div>
        </header>

        <Dialog
          title={t("voice.source")}
          closeLabel={t("common.close")}
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          className="voice-flow-editor"
        >
          <div className="voice-detail-create__intro">
            <Braces aria-hidden="true" size={18} />
            <div>
              <strong>{t("voice.source")}</strong>
              <p>{t("voice.adapter")}</p>
            </div>
          </div>
          <Textarea
            className="code-editor voice-flow-editor__source"
            dir="ltr"
            disabled={pending || !canEdit}
            id="flow-source"
            data-dialog-initial-focus
            label={t("voice.source")}
            onChange={(event) => setSource(event.target.value)}
            rows={18}
            spellCheck={false}
            value={source}
          />
          <div className="voice-flow-editor__actions">
            <Button
              busy={pending}
              disabled={!canEdit}
              onClick={() => void act("/api/voice/flows/validate")}
              variant="secondary"
            >
              {t("voice.validate")}
            </Button>
            <Button
              busy={pending}
              disabled={!canEdit}
              onClick={() => void act("/api/voice/flows/publish")}
            >
              {t("voice.publish")}
            </Button>
          </div>
          {feedback === undefined ? null : (
            <p
              aria-live="polite"
              className={
                feedback.kind === "error"
                  ? "form-error"
                  : "voice-flow-editor__success"
              }
              role={feedback.kind === "error" ? "alert" : "status"}
            >
              {feedback.text}
            </p>
          )}
        </Dialog>

        <div className="tenant-register-toolbar">
          <Input
            id="voice-flow-search"
            type="search"
            label={t("tenantOperations.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select
            id="voice-flow-source"
            label={t("tenantOperations.origin")}
            value={sourceFilter}
            onChange={(event) => setSourceFilter(event.target.value)}
          >
            <option value="all">{t("tenantOperations.allSources")}</option>
            <option value="tenant">{t("voice.tenant")}</option>
            <option value="packaged">{t("voice.packaged")}</option>
          </Select>
          <Select
            id="voice-flow-language"
            label={t("inbox.language")}
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
          >
            <option value="all">{t("tenantOperations.allLanguages")}</option>
            {[...new Set(flows.map((flow) => flow.language))].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          <p role="status">
            {t("tenantOperations.showing", {
              count: visible.length,
              total: flows.length,
            })}
          </p>
        </div>
        <div className="tenant-voice-flow-manager">
          <nav className="tenant-record-list" aria-label={t("voice.flows")}>
            {visible.length ? (
              visible.map((flow) => (
                <button
                  type="button"
                  key={flow.flow_id}
                  aria-current={
                    selected?.flow_id === flow.flow_id ? "true" : undefined
                  }
                  onClick={() => setSelectedId(flow.flow_id)}
                >
                  <span>
                    <strong dir="auto">{flow.name}</strong>
                    <small>
                      <bdi>{flow.language}</bdi> · v{flow.latest_version}
                    </small>
                  </span>
                  <Badge
                    label={t(flow.packaged ? "voice.packaged" : "voice.tenant")}
                    tone="neutral"
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
              aria-label={t("tenantOperations.executionConfiguration")}
            >
              <header className="tenant-register-heading">
                <h3 dir="auto">{selected.name}</h3>
                <Badge label={t("status.published")} tone="positive" />
              </header>
              <dl className="tenant-definition-list">
                <div>
                  <dt>{t("common.version", { version: "" })}</dt>
                  <dd>v{selected.latest_version}</dd>
                </div>
                <div>
                  <dt>{t("inbox.language")}</dt>
                  <dd>
                    <bdi>{selected.language}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{t("tenantOperations.origin")}</dt>
                  <dd>
                    {t(selected.packaged ? "voice.packaged" : "voice.tenant")}
                  </dd>
                </div>
                <div>
                  <dt>{t("tenantOperations.flowIdentifier")}</dt>
                  <dd>
                    <code dir="ltr">{selected.flow_id}</code>
                  </dd>
                </div>
              </dl>
              <p className="tenant-result-count">
                {t("tenantOperations.noFlowHistory")}
              </p>
            </section>
          ) : null}
        </div>
      </Surface>
    </div>
  );
}
