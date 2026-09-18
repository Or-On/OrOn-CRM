"use client";

import { useEffect, useState, type SubmitEvent } from "react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import type {
  AgentQualityConfiguration,
  AgentQualityEvaluation,
  AgentQualityVersion,
  AgentVoiceBinding,
  KnowledgeVersion,
  PronunciationEntry,
} from "@or-on/crm";
import { Button, Checkbox, Input, Select, Textarea } from "@or-on/ui";
import { crmMutation, crmRead } from "../crm";
import { qualityCopy } from "./quality-copy";
import { AgentAudioPreview } from "./agent-audio-preview";
import { AgentProviderEvaluation } from "./agent-provider-evaluation";
import styles from "./agent-quality-workspace.module.css";

type Copy = ReturnType<typeof qualityCopy>;
interface WorkspaceData {
  versions: readonly AgentQualityVersion[];
  voiceBindings: readonly AgentVoiceBinding[];
  knowledge: readonly KnowledgeVersion[];
}
interface QualityResponse {
  versions: readonly AgentQualityVersion[];
  voiceBindings?: readonly AgentVoiceBinding[];
}
const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
const lines = (value: FormDataEntryValue | null) =>
  (typeof value === "string" ? value : "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

export function AgentQualityWorkspace({
  profileId,
}: {
  readonly profileId: string;
}) {
  const locale = useLocale();
  const copy = qualityCopy(locale);
  const router = useRouter();
  const [data, setData] = useState<WorkspaceData>();
  const [selectedId, setSelectedId] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState("");
  const [evaluation, setEvaluation] = useState<AgentQualityEvaluation>();
  const [attempt, setAttempt] = useState(0);
  const endpoint = `/api/orchestration/agents/${profileId}`;
  async function read(signal?: AbortSignal): Promise<WorkspaceData> {
    const [agents, knowledge] = await Promise.all([
      crmRead<QualityResponse>(`${endpoint}/quality`, signal),
      crmRead<{ versions: readonly KnowledgeVersion[] }>(
        "/api/orchestration/knowledge",
        signal,
      ),
    ]);
    return {
      versions: agents.versions,
      voiceBindings: agents.voiceBindings ?? [],
      knowledge: knowledge.versions,
    };
  }
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      crmRead<QualityResponse>(`${endpoint}/quality`, controller.signal),
      crmRead<{ versions: readonly KnowledgeVersion[] }>(
        "/api/orchestration/knowledge",
        controller.signal,
      ),
    ])
      .then(([agents, knowledge]) => {
        if (!controller.signal.aborted) {
          setData({
            versions: agents.versions,
            voiceBindings: agents.voiceBindings ?? [],
            knowledge: knowledge.versions,
          });
          setError(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [endpoint, attempt]);
  const selected =
    data?.versions.find((version) => version.id === selectedId) ??
    data?.versions[0];
  async function run(work: () => Promise<void>) {
    setPending(true);
    setError(false);
    setNotice("");
    try {
      await work();
      setData(await read());
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className={styles.workspace} aria-label={copy.open}>
      <h4>{copy.open}</h4>
      <p className="feature-copy">{copy.testRequired}</p>
      {error ? (
        <div role="alert">
          <p>{copy.failed}</p>
          <Button
            onClick={() => setAttempt((value) => value + 1)}
            variant="quiet"
          >
            {copy.retry}
          </Button>
        </div>
      ) : null}
      {!data && !error ? <p role="status">{copy.loading}</p> : null}
      {selected && data ? (
        <>
          <Select
            id={`quality-history-${profileId}`}
            label={copy.history}
            value={selected.id}
            disabled={pending}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setEvaluation(undefined);
            }}
          >
            {data.versions.map((version) => (
              <option value={version.id} key={version.id}>
                v{version.version} ·{" "}
                {version.publishedAt ? copy.published : copy.draft}
                {data.voiceBindings.some(
                  (binding) => binding.agentVersionId === version.id,
                )
                  ? ` · ${copy.liveVoice}`
                  : ""}
              </option>
            ))}
          </Select>
          <VoiceBindingStatus
            versions={data.versions}
            bindings={data.voiceBindings}
            copy={copy}
          />
          <p>{copy.restore}</p>
          <QualityForm
            key={selected.id}
            version={selected}
            knowledge={data.knowledge}
            copy={copy}
            pending={pending}
            save={(configuration) =>
              run(async () => {
                const result = await crmMutation<{ id: string }>(
                  `${endpoint}/quality`,
                  {
                    ...configuration,
                    baseVersionId: selected.id,
                    latestVersionId: data.versions[0]?.id,
                  },
                );
                setSelectedId(result.id);
                setEvaluation(undefined);
                setNotice(copy.saved);
              })
            }
          />
          <p role="status">{notice}</p>
          <p>
            {copy.tools}:{" "}
            {selected.toolPermissions.length
              ? selected.toolPermissions.join(", ")
              : copy.noTools}
          </p>
          <details>
            <summary>{copy.knowledge}</summary>
            <KnowledgeEditor
              versions={data.knowledge}
              pending={pending}
              copy={copy}
              run={run}
            />
          </details>
          <section className="feature-form" aria-label={copy.evaluate}>
            <h4>{copy.evaluate}</h4>
            <p>{copy.disclaimer}</p>
            <form
              className="feature-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void run(async () => {
                  const result = await crmMutation<{
                    evaluation: AgentQualityEvaluation;
                  }>(`${endpoint}/evaluate`, {
                    versionId: selected.id,
                    text: form.get("text"),
                    factKey: form.get("factKey"),
                  });
                  setEvaluation(result.evaluation);
                });
              }}
            >
              <Textarea
                id={`quality-scenario-${profileId}`}
                label={copy.scenario}
                name="text"
                maxLength={2000}
                required
              />
              <Input
                id={`quality-fact-${profileId}`}
                label={copy.fact}
                name="factKey"
                maxLength={80}
                dir="ltr"
              />
              <Button type="submit" busy={pending}>
                {copy.run}
              </Button>
            </form>
            {evaluation ? (
              <div aria-live="polite" className="feature-form">
                <dl>
                  <dt>{copy.accepted}</dt>
                  <dd dir="auto">{evaluation.acceptedText}</dd>
                  <dt>{copy.response}</dt>
                  <dd dir="auto">{evaluation.response}</dd>
                </dl>
                {evaluation.conflicts.length ? (
                  <p role="alert">
                    {copy.conflicts}: {evaluation.conflicts.join(", ")}
                  </p>
                ) : null}
                <h5>{copy.evidence}</h5>
                {evaluation.sources.length ? (
                  <ul>
                    {evaluation.sources.map((source) => (
                      <li key={source.documentId}>
                        {source.title} · v{source.version} ·{" "}
                        <time>
                          {new Date(source.publishedAt).toLocaleString(locale)}
                        </time>
                        <code>{source.documentId}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{copy.noEvidence}</p>
                )}
                <p>
                  {copy.timing}:{" "}
                  {evaluation.timings.deterministicMs.toLocaleString(locale)} ms
                </p>
                <p>{copy.stages}</p>
              </div>
            ) : null}
          </section>
          <AgentAudioPreview
            key={`audio-${selected.id}`}
            endpoint={endpoint}
            versionId={selected.id}
            published={selected.publishedAt !== null}
            locale={locale}
          />
          <AgentProviderEvaluation
            key={`provider-${selected.id}`}
            endpoint={endpoint}
            versionId={selected.id}
            published={selected.publishedAt !== null}
            locale={locale}
          />
          {selected.validationStatus === "invalid" ? (
            <p role="alert">{copy.invalid}</p>
          ) : null}
          {!selected.publishedAt && selected.id === data.versions[0]?.id ? (
            <Button
              busy={pending}
              disabled={selected.validationStatus !== "valid"}
              onClick={() =>
                void run(async () => {
                  await crmMutation(`${endpoint}/publish`, {});
                })
              }
            >
              {copy.publish}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function VoiceBindingStatus({
  versions,
  bindings,
  copy,
}: {
  readonly versions: readonly AgentQualityVersion[];
  readonly bindings: readonly AgentVoiceBinding[];
  readonly copy: Copy;
}) {
  // Pinning is intentional: this only reports which version new calls use and
  // what must be published to change it. Nothing here rebinds a flow.
  const latestPublished = versions.find((version) => version.publishedAt);
  const boundVersions = bindings.map((binding) => binding.agentVersion);
  const newestBound = boundVersions.length ? Math.max(...boundVersions) : null;
  return (
    <section aria-label={copy.voiceStatus}>
      <h5>{copy.voiceStatus}</h5>
      {bindings.length === 0 ? (
        <p role="status">{copy.voiceNone}</p>
      ) : (
        <ul>
          {bindings.map((binding) => (
            <li key={`${binding.flowDefinitionId}-${binding.agentVersionId}`}>
              <span dir="auto">
                {fill(copy.voiceUses, {
                  agent: binding.agentVersion,
                  flow: binding.flowName,
                  flowVersion: binding.flowVersion,
                })}
              </span>
              {binding.callable ? null : (
                <p role="alert">{copy.voiceNotCallable}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {latestPublished &&
      newestBound !== null &&
      latestPublished.version > newestBound ? (
        <p role="alert">
          {fill(copy.voiceBehind, {
            latest: latestPublished.version,
            agent: newestBound,
          })}
        </p>
      ) : null}
    </section>
  );
}

function QualityForm({
  version,
  knowledge,
  copy,
  pending,
  save,
}: {
  readonly version: AgentQualityVersion;
  readonly knowledge: readonly KnowledgeVersion[];
  readonly copy: Copy;
  readonly pending: boolean;
  readonly save: (body: {
    systemPrompt: string;
    quality: AgentQualityConfiguration;
    sourceIds: FormDataEntryValue[];
  }) => Promise<void>;
}) {
  const quality = version.quality;
  const [dictionary, setDictionary] = useState<readonly PronunciationEntry[]>(
    quality.pronunciationDictionary,
  );
  const sources = [
    ...new Map(knowledge.map((item) => [item.sourceId, item])).values(),
  ];
  const id = `quality-${version.id}`;
  function dictionaryField(
    index: number,
    field: keyof PronunciationEntry,
    value: string | readonly string[],
  ) {
    setDictionary((entries) =>
      entries.map((entry, position) =>
        position === index ? { ...entry, [field]: value } : entry,
      ),
    );
  }
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void save({
      systemPrompt: formText(form, "instructions"),
      sourceIds: form.getAll("sourceIds"),
      quality: {
        schemaVersion: "1.0",
        language: formText(
          form,
          "language",
        ) as AgentQualityConfiguration["language"],
        agentGrammar: formText(
          form,
          "grammar",
        ) as AgentQualityConfiguration["agentGrammar"],
        callerAddressDefault: formText(
          form,
          "caller",
        ) as AgentQualityConfiguration["callerAddressDefault"],
        voiceId: formText(form, "voiceId"),
        speakingPace: Number(form.get("pace")),
        speakingStyle: formText(
          form,
          "style",
        ) as AgentQualityConfiguration["speakingStyle"],
        fallbackBehavior: formText(
          form,
          "fallback",
        ) as AgentQualityConfiguration["fallbackBehavior"],
        budgets: {
          maxResponseTokens: Number(form.get("tokens")),
          maxSessionSeconds: Number(form.get("seconds")),
        },
        sttVocabulary: lines(form.get("vocabulary")),
        pronunciationDictionary: dictionary.map((entry) => ({
          ...entry,
          testCases: entry.testCases
            .map((testCase) => testCase.trim())
            .filter(Boolean),
        })),
      },
    });
  }
  return (
    <form onSubmit={submit} className="feature-form">
      <fieldset className="form-fieldset" disabled={pending}>
        <Textarea
          id={`${id}-instructions`}
          label={copy.instructions}
          name="instructions"
          defaultValue={version.systemPrompt}
          maxLength={16000}
          required
        />
        <Select
          id={`${id}-language`}
          label={copy.language}
          name="language"
          defaultValue={quality.language}
        >
          <option value="he">עברית</option>
          <option value="en">English</option>
        </Select>
        <Select
          id={`${id}-grammar`}
          label={copy.grammar}
          name="grammar"
          defaultValue={quality.agentGrammar}
        >
          {["feminine", "masculine", "neutral"].map((value) => (
            <option key={value} value={value}>
              {copy[value as "feminine"]}
            </option>
          ))}
        </Select>
        <Select
          id={`${id}-caller`}
          label={copy.caller}
          name="caller"
          defaultValue={quality.callerAddressDefault}
        >
          {["unknown", "feminine", "masculine", "neutral"].map((value) => (
            <option key={value} value={value}>
              {copy[value as "unknown"]}
            </option>
          ))}
        </Select>
        <Input
          id={`${id}-voice`}
          label={copy.voice}
          name="voiceId"
          defaultValue={quality.voiceId}
          maxLength={100}
          dir="ltr"
        />
        <Input
          id={`${id}-pace`}
          label={copy.pace}
          name="pace"
          type="number"
          step="0.05"
          min="0.75"
          max="1.25"
          defaultValue={quality.speakingPace}
          required
        />
        <Select
          id={`${id}-style`}
          label={copy.style}
          name="style"
          defaultValue={quality.speakingStyle}
        >
          {["concise", "balanced", "detailed"].map((value) => (
            <option key={value} value={value}>
              {copy[value as "concise"]}
            </option>
          ))}
        </Select>
        <Select
          id={`${id}-fallback`}
          label={copy.fallback}
          name="fallback"
          defaultValue={quality.fallbackBehavior}
        >
          <option value="clarify">{copy.clarify}</option>
          <option value="handoff">{copy.handoff}</option>
        </Select>
        <Input
          id={`${id}-tokens`}
          label={copy.tokens}
          name="tokens"
          type="number"
          min="64"
          max="2048"
          defaultValue={quality.budgets.maxResponseTokens}
          required
        />
        <Input
          id={`${id}-seconds`}
          label={copy.seconds}
          name="seconds"
          type="number"
          min="60"
          max="3600"
          defaultValue={quality.budgets.maxSessionSeconds}
          required
        />
        <Textarea
          id={`${id}-vocabulary`}
          label={copy.vocabulary}
          name="vocabulary"
          maxLength={2112}
          defaultValue={quality.sttVocabulary.join("\n")}
        />
        <fieldset className="form-fieldset">
          <legend>{copy.dictionary}</legend>
          {dictionary.map((entry, index) => (
            <fieldset className="form-fieldset" key={`${id}-${String(index)}`}>
              <legend>{index + 1}</legend>
              <Input
                id={`${id}-original-${String(index)}`}
                label={copy.original}
                value={entry.original}
                onChange={(event) =>
                  dictionaryField(index, "original", event.target.value)
                }
                maxLength={80}
                required
              />
              <Input
                id={`${id}-spoken-${String(index)}`}
                label={copy.spoken}
                value={entry.spoken}
                onChange={(event) =>
                  dictionaryField(index, "spoken", event.target.value)
                }
                maxLength={80}
                required
              />
              <Select
                id={`${id}-dictlang-${String(index)}`}
                label={copy.language}
                value={entry.language}
                onChange={(event) =>
                  dictionaryField(index, "language", event.target.value)
                }
              >
                <option value="he">עברית</option>
                <option value="en">English</option>
              </Select>
              <Input
                id={`${id}-context-${String(index)}`}
                label={copy.context}
                value={entry.context}
                onChange={(event) =>
                  dictionaryField(index, "context", event.target.value)
                }
                maxLength={120}
              />
              <Textarea
                id={`${id}-cases-${String(index)}`}
                label={copy.cases}
                value={entry.testCases.join("\n")}
                onChange={(event) =>
                  dictionaryField(
                    index,
                    "testCases",
                    event.target.value.split("\n"),
                  )
                }
              />
              <Button
                type="button"
                variant="quiet"
                onClick={() =>
                  setDictionary((entries) =>
                    entries.filter((_, position) => position !== index),
                  )
                }
              >
                {copy.remove}
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="secondary"
            disabled={dictionary.length >= 64}
            onClick={() =>
              setDictionary((entries) => [
                ...entries,
                {
                  original: "",
                  spoken: "",
                  language: quality.language,
                  context: "",
                  testCases: [],
                },
              ])
            }
          >
            {copy.add}
          </Button>
        </fieldset>
        <fieldset className="form-fieldset">
          <legend>{copy.knowledge}</legend>
          {!sources.length ? (
            <p>{copy.noKnowledge}</p>
          ) : (
            sources.map((source) => (
              <Checkbox
                key={source.sourceId}
                name="sourceIds"
                value={source.sourceId}
                defaultChecked={version.sourceIds.includes(source.sourceId)}
              >
                {copy.select}: {source.sourceName}
              </Checkbox>
            ))
          )}
          {version.sourceIds
            .filter(
              (sourceId) =>
                !sources.some((source) => source.sourceId === sourceId),
            )
            .map((sourceId) => (
              <Checkbox
                key={sourceId}
                name="sourceIds"
                value={sourceId}
                defaultChecked
              >
                {copy.noEvidence}: {sourceId}
              </Checkbox>
            ))}
        </fieldset>
        <Button type="submit" busy={pending}>
          {copy.save}
        </Button>
      </fieldset>
    </form>
  );
}

function KnowledgeEditor({
  versions,
  pending,
  copy,
  run,
}: {
  readonly versions: readonly KnowledgeVersion[];
  readonly pending: boolean;
  readonly copy: Copy;
  readonly run: (work: () => Promise<void>) => Promise<void>;
}) {
  const [base, setBase] = useState<KnowledgeVersion>();
  const [factCount, setFactCount] = useState(1);
  const [formKey, setFormKey] = useState(0);
  const facts = base?.facts ?? [];
  const change = (documentId: string, action: string) =>
    run(async () => {
      await crmMutation(
        "/api/orchestration/knowledge",
        { documentId, action },
        { method: "PATCH" },
      );
    });
  return (
    <div className="feature-form">
      {!versions.length ? (
        <p>{copy.noKnowledge}</p>
      ) : (
        <ul>
          {versions.map((version) => {
            const stale =
              new Date(version.validFrom).getTime() > Date.now() ||
              (version.validUntil !== null &&
                new Date(version.validUntil).getTime() <= Date.now());
            return (
              <li key={version.documentId}>
                <strong dir="auto">{version.title}</strong> · v{version.version}{" "}
                ·{" "}
                {version.revokedAt || version.sourceStatus === "revoked"
                  ? copy.revoked
                  : version.publishedAt
                    ? copy.published
                    : copy.draft}
                {stale ? <span> · {copy.stale}</span> : null}
                <Button
                  type="button"
                  size="small"
                  variant="quiet"
                  disabled={pending}
                  onClick={() => {
                    setBase(version);
                    setFactCount(Math.max(1, version.facts.length));
                    setFormKey((key) => key + 1);
                  }}
                >
                  {copy.revision}
                </Button>
                {!version.publishedAt ? (
                  <Button
                    type="button"
                    size="small"
                    variant="secondary"
                    busy={pending}
                    onClick={() => void change(version.documentId, "publish")}
                  >
                    {copy.publishKnowledge}
                  </Button>
                ) : !version.revokedAt ? (
                  <Button
                    type="button"
                    size="small"
                    variant="quiet"
                    busy={pending}
                    onClick={() => void change(version.documentId, "revoke")}
                  >
                    {copy.revoke}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Button
        type="button"
        variant="quiet"
        onClick={() => {
          setBase(undefined);
          setFactCount(1);
          setFormKey((key) => key + 1);
        }}
      >
        {copy.clear}
      </Button>
      <form
        key={formKey}
        className="feature-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void run(async () => {
            await crmMutation("/api/orchestration/knowledge", {
              sourceId: base?.sourceId ?? "",
              title: form.get("title"),
              content: form.get("content"),
              facts: Array.from({ length: factCount }, (_, index) => ({
                factKey: form.get(`key-${String(index)}`),
                value: form.get(`value-${String(index)}`),
              })),
              validFrom: new Date(`${formText(form, "from")}Z`).toISOString(),
              validUntil: form.get("until")
                ? new Date(`${formText(form, "until")}Z`).toISOString()
                : null,
            });
          });
        }}
      >
        <fieldset className="form-fieldset" disabled={pending}>
          <legend>{base ? copy.revision : copy.newSource}</legend>
          <Input
            id="knowledge-title"
            label={copy.title}
            name="title"
            defaultValue={base?.title ?? ""}
            maxLength={160}
            required
          />
          <Textarea
            id="knowledge-content"
            label={copy.content}
            name="content"
            defaultValue={base?.content ?? ""}
            maxLength={16000}
            required
          />
          <p>{copy.factsHint}</p>
          {Array.from({ length: factCount }, (_, index) => (
            <div key={index} className="feature-form">
              <Input
                id={`knowledge-key-${String(index)}`}
                label={`${copy.key} ${String(index + 1)}`}
                name={`key-${String(index)}`}
                defaultValue={facts[index]?.factKey ?? ""}
                maxLength={80}
                pattern="[a-z][a-z0-9_.-]{0,79}"
                dir="ltr"
                required
              />
              <Textarea
                id={`knowledge-value-${String(index)}`}
                label={`${copy.statement} ${String(index + 1)}`}
                name={`value-${String(index)}`}
                defaultValue={facts[index]?.value ?? ""}
                maxLength={1200}
                required
              />
            </div>
          ))}
          <Button
            type="button"
            variant="quiet"
            disabled={factCount >= 40}
            onClick={() => setFactCount((count) => count + 1)}
          >
            {copy.addFact}
          </Button>
          <Input
            id="knowledge-valid-from"
            label={copy.from}
            name="from"
            type="datetime-local"
            defaultValue={
              base?.validFrom.slice(0, 16) ??
              new Date().toISOString().slice(0, 16)
            }
            required
          />
          <Input
            id="knowledge-valid-until"
            label={copy.until}
            name="until"
            type="datetime-local"
            defaultValue={base?.validUntil?.slice(0, 16) ?? ""}
          />
          <Button type="submit" busy={pending}>
            {copy.saveKnowledge}
          </Button>
        </fieldset>
      </form>
    </div>
  );
}
