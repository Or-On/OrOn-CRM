"use client";

import { useEffect, useState } from "react";
import { Button, Select } from "@or-on/ui";
import styles from "./publication-workspace.module.css";

export interface EffectivePromptView {
  text: string;
  blocks: readonly {
    id: string;
    authority: string;
    text: string;
    source?: unknown;
  }[];
  hash: string;
  hashScope: string;
  compositionVersion: string;
  characterCount: number;
  context: { state: string; view: string; [key: string]: unknown };
  contextOptions: readonly {
    processId: string;
    label: string;
    nodeId?: string;
  }[];
  exclusions: readonly string[];
  scriptedOpening: {
    text: string;
    source: string;
    flowId: string;
    flowVersion: number;
  } | null;
}

/** Displays only the server's actual composition. React escapes all source text. */
function EffectivePromptContent({
  profileId,
  versionId,
}: {
  readonly profileId: string;
  readonly versionId: string;
}) {
  const [channel, setChannel] = useState("whatsapp");
  const [selection, setSelection] = useState("");
  const [options, setOptions] = useState<EffectivePromptView["contextOptions"]>(
    [],
  );
  const [data, setData] = useState<EffectivePromptView>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setData(undefined);
    setError("");
    setCopied(false);
    const query = new URLSearchParams({ channel });
    if (selection) {
      const [processId, nodeId] = selection.split("|");
      if (processId) query.set("processId", processId);
      if (nodeId) query.set("nodeId", nodeId);
    }
    void fetch(
      `/api/orchestration/agents/${profileId}/versions/${versionId}/effective-prompt?${query}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (response) => {
        const body = (await response.json()) as EffectivePromptView & {
          error?: string;
        };
        if (controller.signal.aborted) return;
        if (
          response.status === 409 &&
          body.error === "effective_prompt_context_required"
        ) {
          setOptions(body.contextOptions);
          setError("בחרו מסלול כדי להציג את ההוראות המדויקות שלו.");
          return;
        }
        if (!response.ok) throw new Error("load_failed");
        setData(body);
        setOptions(body.contextOptions);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("לא ניתן לטעון את הפרומפט. התצורה לא השתנתה.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [profileId, versionId, channel, selection, attempt]);
  return (
    <section
      className={styles.inspector}
      dir="rtl"
      aria-label="הפרומפט שרץ בפועל"
    >
      <h3>הפרומפט שרץ בפועל</h3>
      <p>תצוגת הוראות לתצורה שנבחרה, ללא שחזור שיחת לקוח.</p>
      <Select
        id={`prompt-channel-${profileId}`}
        label="ערוץ"
        value={channel}
        onChange={(event) => {
          setChannel(event.target.value);
          setSelection("");
          setOptions([]);
        }}
      >
        <option value="whatsapp">WhatsApp</option>
        <option value="voice">טלפון</option>
      </Select>
      {options.length > 0 ? (
        <Select
          id={`prompt-context-${profileId}`}
          label="מסלול"
          value={selection}
          onChange={(event) => setSelection(event.target.value)}
        >
          <option value="">בחרו מסלול</option>
          {options.map((option) => (
            <option
              key={`${option.processId}|${option.nodeId ?? ""}`}
              value={`${option.processId}|${option.nodeId ?? ""}`}
            >
              {option.label}
            </option>
          ))}
        </Select>
      ) : null}
      {loading ? <p role="status">טוען הוראות…</p> : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button variant="secondary" onClick={() => setAttempt(attempt + 1)}>
            ניסיון נוסף
          </Button>
        </div>
      ) : null}
      {data ? (
        <>
          <p role="status">
            {(
              {
                active: "פעיל לשיחות חדשות",
                pinned: "השיוך נעול לגרסה זו",
                draft: "תצוגת טיוטה — אינה פעילה",
                published_pending_activation: "פורסם, ממתין להפעלה",
              } as Record<string, string>
            )[data.context.state] ?? data.context.state}
          </p>
          <dl className={styles.metadata}>
            {Object.entries(data.context)
              .filter(([, value]) => value !== null)
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd dir="ltr">
                    {typeof value === "string" ? value : JSON.stringify(value)}
                  </dd>
                </div>
              ))}
          </dl>
          <p>
            {data.characterCount} תווי Unicode ·{" "}
            <bdi>{data.compositionVersion}</bdi>
          </p>
          <p>
            טביעת הוראות: <code dir="ltr">{data.hash}</code>
          </p>
          <small dir="ltr">{data.hashScope}</small>
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard
                .writeText(data.text)
                .then(() => setCopied(true))
                .catch(() =>
                  setError("ההעתקה נכשלה. אפשר לסמן את הטקסט ולהעתיק ידנית."),
                );
            }}
          >
            העתקת הפרומפט
          </Button>
          {copied ? <span role="status">הועתק</span> : null}
          {data.blocks.map((block) => (
            <article
              key={block.id}
              className={styles.block}
              data-authority={block.authority}
            >
              <h4>
                {block.authority} · <bdi>{block.id}</bdi>
              </h4>
              {block.source ? (
                <small>
                  {typeof block.source === "string"
                    ? block.source
                    : JSON.stringify(block.source)}
                </small>
              ) : null}
              <pre dir="auto">{block.text}</pre>
            </article>
          ))}
          <details>
            <summary>הטקסט המלא לפי סדר ההרכבה</summary>
            <pre dir="auto">{data.text}</pre>
          </details>
          {data.scriptedOpening ? (
            <article className={styles.block}>
              <h4>פתיחה מוקראת — עשויה לעקוף את המודל</h4>
              <p dir="auto">{data.scriptedOpening.text}</p>
              <small>
                {data.scriptedOpening.source} ·{" "}
                <bdi>
                  {data.scriptedOpening.flowId} v
                  {data.scriptedOpening.flowVersion}
                </bdi>
              </small>
            </article>
          ) : null}
          <h4>מה אינו כלול בתצוגה</h4>
          <ul>
            {data.exclusions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

export function EffectivePromptInspector(props: {
  readonly profileId: string;
  readonly versionId: string;
  readonly publishedVersionId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string>();
  const exactVersion = selectedVersion ?? props.versionId;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>הפרומפט שרץ בפועל</summary>
      {open ? (
        <>
          {props.publishedVersionId &&
          props.publishedVersionId !== props.versionId ? (
            <Select
              id={`prompt-version-${props.profileId}`}
              label="גרסת סוכן לבדיקה"
              value={exactVersion}
              onChange={(event) => setSelectedVersion(event.target.value)}
            >
              <option value={props.versionId}>גרסת העבודה הנוכחית</option>
              <option value={props.publishedVersionId}>
                הגרסה שפורסמה — השיוך הפעיל נקבע לפי המסלול
              </option>
            </Select>
          ) : null}
          <EffectivePromptContent
            profileId={props.profileId}
            versionId={exactVersion}
          />
        </>
      ) : null}
    </details>
  );
}
