"use client";

import { useEffect, useState } from "react";
import type { WhatsAppTemplate, WhatsAppTemplatePage } from "./catalog";
import styles from "./template-browser.module.css";

/** Read-only catalog. Selecting a card previews it; it never queues delivery. */
export function TemplateBrowser({
  conversationId,
  locale,
}: {
  readonly conversationId: string;
  readonly locale: string;
}) {
  return (
    <TemplateBrowserToggle
      key={conversationId}
      conversationId={conversationId}
      locale={locale}
    />
  );
}

function TemplateBrowserToggle({
  conversationId,
  locale,
}: {
  readonly conversationId: string;
  readonly locale: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.browser}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {locale === "he"
          ? "תבניות WhatsApp קיימות"
          : "Existing WhatsApp templates"}
      </button>
      {open && (
        <ConversationTemplateBrowser
          conversationId={conversationId}
          locale={locale}
        />
      )}
    </div>
  );
}

function ConversationTemplateBrowser({
  conversationId,
  locale,
}: {
  readonly conversationId: string;
  readonly locale: string;
}) {
  const he = locale === "he";
  const [templates, setTemplates] = useState<readonly WhatsAppTemplate[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [selected, setSelected] = useState<WhatsAppTemplate | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [language, setLanguage] = useState("all");
  const [approvedOnly, setApprovedOnly] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    void fetch(
      `/api/messaging/conversations/${encodeURIComponent(conversationId)}/templates${cursor === null ? "" : `?after=${encodeURIComponent(cursor)}`}`,
      { signal: abort.signal, cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("catalog unavailable");
        return response.json() as Promise<WhatsAppTemplatePage>;
      })
      .then((page) => {
        if (abort.signal.aborted) return;
        setTemplates((previous) =>
          cursor === null
            ? page.templates
            : [
                ...new Map(
                  [...previous, ...page.templates].map((item) => [
                    item.id,
                    item,
                  ]),
                ).values(),
              ],
        );
        setAfter(page.after);
        setError(false);
        setLoading(false);
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setError(true);
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [conversationId, cursor, attempt]);
  const visible = templates.filter(
    (item) =>
      (!approvedOnly || item.status === "APPROVED") &&
      (language === "all" || item.language === language),
  );
  return (
    <section
      className={styles.browser}
      aria-label={he ? "תבניות WhatsApp" : "WhatsApp templates"}
    >
      <h3>{he ? "תבניות WhatsApp קיימות" : "Existing WhatsApp templates"}</h3>
      <p>
        {he
          ? "תצוגה מקדימה בלבד. בחירה כאן אינה שולחת הודעה."
          : "Preview only. Selecting a template does not send a message."}
      </p>
      <div className={styles.filters}>
        <label>
          {he ? "שפה" : "Language"}
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
          >
            <option value="all">{he ? "כל השפות" : "All languages"}</option>
            {[...new Set(templates.map((item) => item.language))].map(
              (item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={approvedOnly}
            onChange={(event) => setApprovedOnly(event.target.checked)}
          />
          {he ? "מאושרות בלבד" : "Approved only"}
        </label>
      </div>
      {loading && (
        <p role="status">{he ? "טוען תבניות…" : "Loading templates…"}</p>
      )}
      {error && (
        <div role="alert">
          <p>
            {he
              ? "לא ניתן לטעון תבניות כעת."
              : "Templates are currently unavailable."}
          </p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setAttempt((value) => value + 1);
            }}
          >
            {he ? "נסה שוב" : "Try again"}
          </button>
        </div>
      )}
      {!loading && !error && visible.length === 0 && (
        <p>
          {he
            ? "אין תבניות המתאימות למסנן."
            : "No templates match these filters."}
        </p>
      )}
      <ul className={styles.list}>
        {visible.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => setSelected(item)}
              aria-pressed={selected?.id === item.id}
            >
              <strong dir="auto">{item.name}</strong>
              <span>
                {item.language} · {item.status} · {item.category}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {after !== null && !loading && (
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setCursor(after);
          }}
        >
          {he ? "טען עוד" : "Load more"}
        </button>
      )}
      {selected && (
        <article
          className={styles.preview}
          aria-label={he ? "תצוגה מקדימה" : "Template preview"}
        >
          <h4 dir="auto">{selected.name}</h4>
          <p dir="auto">{selected.preview}</p>
          {selected.buttons.map((button, index) => (
            <span className={styles.buttonPreview} key={index} dir="auto">
              {button.text}
            </span>
          ))}
          <p>
            {he
              ? "משתנים מוצגים כפי שהוגדרו בתבנית; אין החלפת נתונים או שליחה."
              : "Placeholders are shown as defined; no substitution or delivery occurs."}
          </p>
        </article>
      )}
    </section>
  );
}
