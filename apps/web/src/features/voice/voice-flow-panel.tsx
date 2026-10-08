"use client";
import type {
  ComponentCatalog,
  FlowSummary,
  FlowSourceResult,
  FlowPublishResult,
  FlowValidationResult,
} from "@or-on/api-client";
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
import { useEffect, useRef, useState } from "react";
import { StructuredVoiceSource } from "./source-editor";
import { errorMessage } from "../../i18n/error-message";
import { useCapability } from "../access";
import { crmMutation } from "../crm";
import { PublicationResult, type PublicationView } from "../orchestration";
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
  const canOperate = useCapability("voice:operate");
  const canManageFlows = useCapability("flows:manage");
  const canManageCampaigns = useCapability("campaigns:manage");
  const canEdit = canOperate && canManageFlows && canManageCampaigns;
  const router = useRouter();
  const [editorOpen, setEditorOpen] = useState(false);
  const [source, setSource] = useState("");
  const [feedback, setFeedback] = useState<FlowFeedback>();
  const [pending, setPending] = useState(false);
  const [publication, setPublication] = useState<PublicationView>();
  const [publishedSelection, setPublishedSelection] = useState<{
    flowId: string;
    version: number;
  }>();
  const dirtyRef = useRef(false);
  const [loaded, setLoaded] = useState<FlowSourceResult>();
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [dirty, setDirty] = useState(false);
  const requestId = useRef(crypto.randomUUID());
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
  const sourceVersion =
    publishedSelection?.flowId === selected?.flow_id
      ? publishedSelection?.version
      : selected?.latest_version;
  useEffect(() => {
    if (!selected || dirtyRef.current) return;
    const controller = new AbortController();
    setLoading(true);
    setLoaded(undefined);
    setSource("");
    setDirty(false);
    setFeedback(undefined);
    void fetch(
      `/api/voice/flows/${selected.flow_id}/versions/${String(sourceVersion)}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("load_failed");
        const result = (await response.json()) as NonNullable<typeof loaded>;
        if (!controller.signal.aborted) {
          setLoaded(result);
          setSource(JSON.stringify(result.source, null, 2));
          requestId.current = crypto.randomUUID();
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setFeedback({
            kind: "error",
            text: "לא ניתן לטעון את מקור התהליך. נסו שוב.",
          });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selected?.flow_id, sourceVersion, attempt]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function changeSource(value: string) {
    setSource(value);
    setDirty(true);
    dirtyRef.current = true;
    requestId.current = crypto.randomUUID();
  }
  async function act(path: string) {
    if (!loaded?.editable || !canEdit) return;
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
      const result = (await voiceMutation(path, {
        source: parsed,
        expected_base_version: loaded.base_version,
        expected_revision: loaded.revision,
        request_id: requestId.current,
      })) as Partial<FlowPublishResult & FlowValidationResult>;
      if (result.valid === false) {
        setFeedback({
          kind: "error",
          text: result.errors?.join("; ") ?? t("voice.flowFailed"),
        });
      } else {
        setFeedback({
          kind: "success",
          text: path.endsWith("publish")
            ? "פורסם, ממתין להפעלה — אין שינוי בשיחות חדשות עד לאישור השיוך"
            : t("voice.valid"),
        });
        if (path.endsWith("publish")) {
          const staged = result.publication;
          setPublication({
            status: "published_pending_activation",
            impacts: [],
            ...(staged?.operationId ? { operationId: staged.operationId } : {}),
          });
          if (staged?.operationId) {
            try {
              const activated = await crmMutation<{
                publication: PublicationView;
              }>(
                `/api/orchestration/publications/${staged.operationId}/activate`,
                {},
              );
              setPublication(activated.publication);
            } catch {
              setFeedback({
                kind: "error",
                text: "הגרסה פורסמה אך הפעלתה לא הושלמה. המסלול הקודם נשאר פעיל. אפשר להשלים בבדיקת התצורה.",
              });
            }
          }
          setDirty(false);
          dirtyRef.current = false;
          if (result.flow)
            setPublishedSelection({
              flowId: result.flow.flow_id,
              version: result.flow.latest_version,
            });
          router.refresh();
          setAttempt((value) => value + 1);
        }
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
      {publication ? <PublicationResult result={publication} /> : null}
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
              disabled={loading || !loaded}
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
          {loaded ? (
            <p dir="rtl">
              גרסה {loaded.version} ·{" "}
              {loaded.origin === "packaged"
                ? "מקור משותף לקריאה בלבד"
                : "מקור השייך לטננט"}{" "}
              · הגרסה האחרונה שפורסמה; אין בכך אישור שזה המסלול הפעיל.
            </p>
          ) : null}
          <StructuredVoiceSource
            source={source}
            disabled={pending || !canEdit || !loaded?.editable}
            onChange={changeSource}
          />
          <details>
            <summary>JSON מתקדם — אותו מקור</summary>
            <Textarea
              className="code-editor voice-flow-editor__source"
              dir="ltr"
              disabled={pending || !canEdit || !loaded?.editable}
              id="flow-source"
              data-dialog-initial-focus
              label={t("voice.source")}
              onChange={(event) => changeSource(event.target.value)}
              rows={18}
              spellCheck={false}
              value={source}
            />
          </details>
          {dirty ? <p role="status">שינויים לא שמורים</p> : null}
          <div className="voice-flow-editor__actions">
            <Button
              busy={pending}
              disabled={!canEdit || !loaded?.editable || loading}
              onClick={() => void act("/api/voice/flows/validate")}
              variant="secondary"
            >
              {t("voice.validate")}
            </Button>
            <Button
              busy={pending}
              disabled={!canEdit || !loaded?.editable || loading}
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
        {loading ? <p role="status">טוען מקור…</p> : null}
        {!loaded && feedback ? (
          <div role="alert">
            <p>{feedback.text}</p>
            <Button onClick={() => setAttempt(attempt + 1)}>ניסיון נוסף</Button>
          </div>
        ) : null}
        <div className="tenant-register-toolbar">
          <Input
            id="voice-flow-search"
            type="search"
            label={t("tenantOperations.search")}
            value={query}
            disabled={dirty || pending}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select
            id="voice-flow-source"
            label={t("tenantOperations.origin")}
            value={sourceFilter}
            disabled={dirty || pending}
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
            disabled={dirty || pending}
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
                  disabled={pending}
                  aria-current={
                    selected?.flow_id === flow.flow_id ? "true" : undefined
                  }
                  onClick={() => {
                    if (
                      !dirty ||
                      window.confirm(
                        "יש שינויים לא שמורים. לעבור לתהליך אחר ולוותר עליהם?",
                      )
                    ) {
                      dirtyRef.current = false;
                      setDirty(false);
                      setSelectedId(flow.flow_id);
                    }
                  }}
                >
                  <span>
                    <strong dir="auto">{flow.name}</strong>
                    <small>
                      <bdi>{flow.language}</bdi> ֲ· v{flow.latest_version}
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
