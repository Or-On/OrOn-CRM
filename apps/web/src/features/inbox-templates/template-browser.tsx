"use client";

import {
  CornerUpLeft,
  ExternalLink,
  FileText,
  MessageSquareText,
  Phone,
  Search,
  Send,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Button, Checkbox, Input } from "@or-on/ui";
import {
  renderTemplateText,
  type WhatsAppTemplate,
  type WhatsAppTemplatePage,
} from "./catalog";
import {
  templateCategoryName,
  templateLanguageName,
  templateStatus,
  templateUnsupportedReason,
} from "./template-labels";
import styles from "./template-browser.module.css";

type TemplateAction = (
  template: WhatsAppTemplate,
  parameters: readonly string[],
) => void;

export interface TemplateBrowserProps {
  readonly conversationId: string;
  readonly locale: string;
  readonly expanded?: boolean;
  /** Fills the reply composer; never sends. */
  readonly onSelect?: TemplateAction;
  /** Queues the approved template for this conversation. Rejects with a message to show. */
  readonly onSend?: (
    template: WhatsAppTemplate,
    parameters: readonly string[],
  ) => Promise<void>;
  /** Why delivery is unavailable right now; disables sending when present. */
  readonly sendUnavailable?: string;
}

/** Selecting previews a template; only the explicit actions fill or send. */
export function TemplateBrowser({
  conversationId,
  locale,
  expanded = false,
  onSelect,
  onSend,
  sendUnavailable,
}: TemplateBrowserProps) {
  if (expanded)
    return (
      <ConversationTemplateBrowser
        key={conversationId}
        conversationId={conversationId}
        locale={locale}
        onSelect={onSelect}
        onSend={onSend}
        sendUnavailable={sendUnavailable}
      />
    );
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
    <div className={styles.toggle}>
      <Button
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        variant="secondary"
      >
        <FileText aria-hidden="true" size={16} />
        {locale.startsWith("he")
          ? "תבניות WhatsApp קיימות"
          : "Existing WhatsApp templates"}
      </Button>
      {open && (
        <ConversationTemplateBrowser
          conversationId={conversationId}
          locale={locale}
        />
      )}
    </div>
  );
}

function compareTemplates(left: WhatsAppTemplate, right: WhatsAppTemplate) {
  const approved =
    Number(right.status === "APPROVED") - Number(left.status === "APPROVED");
  return (
    approved ||
    left.name.localeCompare(right.name) ||
    left.language.localeCompare(right.language)
  );
}

function ConversationTemplateBrowser({
  conversationId,
  locale,
  onSelect,
  onSend,
  sendUnavailable,
}: {
  readonly conversationId: string;
  readonly locale: string;
  readonly onSelect?: TemplateAction | undefined;
  readonly onSend?: TemplateBrowserProps["onSend"] | undefined;
  readonly sendUnavailable?: string | undefined;
}) {
  const he = locale.startsWith("he");
  const copy = (en: string, hebrew: string) => (he ? hebrew : en);
  const [templates, setTemplates] = useState<readonly WhatsAppTemplate[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [language, setLanguage] = useState("all");
  const [approvedOnly, setApprovedOnly] = useState(true);
  const [query, setQuery] = useState("");
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
  const languages = useMemo(
    () => [...new Set(templates.map((item) => item.language))].sort(),
    [templates],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale).replace(/_/gu, " ");
    return templates
      .filter(
        (item) =>
          (!approvedOnly || item.status === "APPROVED") &&
          (language === "all" || item.language === language) &&
          (needle === "" ||
            `${item.name.replace(/_/gu, " ")} ${item.body ?? item.preview}`
              .toLocaleLowerCase(locale)
              .includes(needle)),
      )
      .toSorted(compareTemplates);
  }, [templates, approvedOnly, language, query, locale]);
  const selected = templates.find((item) => item.id === selectedId) ?? null;
  return (
    <section
      className={styles.browser}
      aria-label={copy("WhatsApp templates", "תבניות WhatsApp")}
    >
      <p className={styles.intro}>
        {onSend
          ? copy(
              "Choose an approved template, fill in any variables and send it to the customer.",
              "בחרו תבנית מאושרת, מלאו את המשתנים אם יש, ושלחו אותה ללקוח.",
            )
          : onSelect
            ? copy(
                "Choose an approved template to fill the reply.",
                "בחרו תבנית מאושרת כדי למלא את התשובה.",
              )
            : copy(
                "Preview only. Selecting a template does not send a message.",
                "תצוגה מקדימה בלבד. בחירה כאן אינה שולחת הודעה.",
              )}
      </p>
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search aria-hidden="true" size={16} />
          <input
            aria-label={copy("Search templates", "חיפוש תבנית")}
            className={styles.searchInput}
            dir="auto"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy("Search templates", "חיפוש תבנית")}
            type="search"
            value={query}
          />
        </label>
        <Checkbox
          checked={approvedOnly}
          onChange={(event) => setApprovedOnly(event.target.checked)}
        >
          {copy("Approved only", "מאושרות בלבד")}
        </Checkbox>
      </div>
      {languages.length > 1 ? (
        <div
          aria-label={copy("Language", "שפה")}
          className={styles.chips}
          role="group"
        >
          {["all", ...languages].map((item) => (
            <button
              aria-pressed={language === item}
              className={styles.chip}
              key={item}
              onClick={() => setLanguage(item)}
              type="button"
            >
              {item === "all"
                ? copy("All languages", "כל השפות")
                : templateLanguageName(item, locale)}
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.layout}>
        <div className={styles.listPane}>
          {loading && (
            <p className={styles.state} role="status">
              {copy("Loading templates…", "טוען תבניות…")}
            </p>
          )}
          {error && (
            <div className={styles.state} role="alert">
              <p>
                {copy(
                  "Templates are currently unavailable.",
                  "לא ניתן לטעון תבניות כעת.",
                )}
              </p>
              <Button
                onClick={() => {
                  setLoading(true);
                  setAttempt((value) => value + 1);
                }}
                size="small"
                variant="secondary"
              >
                {copy("Try again", "נסה שוב")}
              </Button>
            </div>
          )}
          {!loading && !error && visible.length === 0 && (
            <p className={styles.state}>
              {copy(
                "No templates match these filters.",
                "אין תבניות המתאימות לסינון.",
              )}
            </p>
          )}
          <ul className={styles.list}>
            {visible.map((item) => {
              const status = templateStatus(item.status, he);
              const variables = item.draft?.parameterCount ?? 0;
              return (
                <li key={item.id}>
                  <button
                    aria-pressed={selectedId === item.id}
                    className={styles.item}
                    onClick={() => setSelectedId(item.id)}
                    type="button"
                  >
                    <span className={styles.itemTop}>
                      <strong className={styles.itemName} dir="ltr">
                        {item.name}
                      </strong>
                      <span className={styles.status} data-tone={status.tone}>
                        {status.label}
                      </span>
                    </span>
                    {(item.body ?? item.preview) === "" ? null : (
                      <span className={styles.itemExcerpt} dir="auto">
                        {item.body ?? item.preview}
                      </span>
                    )}
                    <span className={styles.meta}>
                      <span className={styles.tag}>
                        {templateLanguageName(item.language, locale)}
                      </span>
                      <span className={styles.tag}>
                        {templateCategoryName(item.category, he)}
                      </span>
                      {variables > 0 ? (
                        <span className={styles.tag}>
                          {copy(
                            `${String(variables)} variable${variables === 1 ? "" : "s"}`,
                            variables === 1
                              ? "משתנה אחד"
                              : `${String(variables)} משתנים`,
                          )}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {after !== null && !loading && (
            <Button
              className={styles.more}
              onClick={() => {
                setLoading(true);
                setCursor(after);
              }}
              size="small"
              variant="quiet"
            >
              {copy("Load more", "טען עוד")}
            </Button>
          )}
        </div>
        {selected === null ? (
          <div className={styles.placeholder}>
            <MessageSquareText aria-hidden="true" size={28} />
            <p>
              {copy(
                "Choose a template to see how the message will look.",
                "בחרו תבנית כדי לראות איך ההודעה תיראה.",
              )}
            </p>
          </div>
        ) : (
          <TemplatePreview
            key={selected.id}
            locale={locale}
            onSelect={onSelect}
            onSend={onSend}
            sendUnavailable={sendUnavailable}
            template={selected}
          />
        )}
      </div>
    </section>
  );
}

const buttonIcons: Readonly<Record<string, ReactNode>> = {
  QUICK_REPLY: <CornerUpLeft aria-hidden="true" size={14} />,
  URL: <ExternalLink aria-hidden="true" size={14} />,
  PHONE_NUMBER: <Phone aria-hidden="true" size={14} />,
};

/** Literal text only: placeholders are highlighted, never interpreted as markup. */
function TemplateText({
  text,
  values,
}: {
  readonly text: string;
  readonly values: readonly string[];
}) {
  const parts = text.split(/(\{\{\d+\}\})/u);
  if (parts.length === 1) return text;
  return parts.map((part, index) => {
    const position = /^\{\{(\d+)\}\}$/u.exec(part)?.[1];
    if (position === undefined) return part;
    const value = values[Number(position) - 1]?.trim() ?? "";
    return (
      <mark
        className={value === "" ? styles.variableEmpty : styles.variable}
        key={index}
      >
        {value === "" ? part : value}
      </mark>
    );
  });
}

function TemplatePreview({
  template,
  locale,
  onSelect,
  onSend,
  sendUnavailable,
}: {
  readonly template: WhatsAppTemplate;
  readonly locale: string;
  readonly onSelect?: TemplateAction | undefined;
  readonly onSend?: TemplateBrowserProps["onSend"] | undefined;
  readonly sendUnavailable?: string | undefined;
}) {
  const he = locale.startsWith("he");
  const copy = (en: string, hebrew: string) => (he ? hebrew : en);
  const parameterCount = template.draft?.parameterCount ?? 0;
  const [values, setValues] = useState<readonly string[]>(() =>
    Array.from({ length: parameterCount }, () => ""),
  );
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const status = templateStatus(template.status, he);
  const approved = template.status === "APPROVED";
  const supported = template.draft !== null && template.draft !== undefined;
  const complete = values.every((value) => value.trim() !== "");
  const usable = approved && supported && complete;
  const body = template.body ?? template.preview;
  const parameters = values.map((value) => value.trim());
  return (
    <article
      aria-label={copy("Template preview", "תצוגה מקדימה")}
      className={styles.preview}
    >
      <header className={styles.previewHead}>
        <div>
          <h4 dir="ltr">{template.name}</h4>
          <p>
            {templateLanguageName(template.language, locale)} ·{" "}
            {templateCategoryName(template.category, he)}
          </p>
        </div>
        <Badge label={status.label} tone={status.tone} />
      </header>
      <div className={styles.chat}>
        <div className={styles.bubble} dir="auto">
          {template.header ? (
            <strong className={styles.bubbleHeader}>
              {renderTemplateText(template.header, [])}
            </strong>
          ) : null}
          <p className={styles.bubbleBody}>
            <TemplateText text={body} values={values} />
          </p>
          {template.footer ? (
            <small className={styles.bubbleFooter}>{template.footer}</small>
          ) : null}
        </div>
        {template.buttons.length > 0 ? (
          <div className={styles.bubbleButtons}>
            {template.buttons.map((button, index) => (
              <span className={styles.bubbleButton} dir="auto" key={index}>
                {buttonIcons[button.type] ?? null}
                {button.text}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {supported && parameterCount > 0 ? (
        <fieldset className={styles.variables} disabled={sending}>
          <legend>{copy("Variable values", "ערכים למשתנים")}</legend>
          {values.map((value, index) => (
            <Input
              dir="auto"
              id={`template-${template.id}-variable-${String(index + 1)}`}
              key={index}
              label={`{{${String(index + 1)}}}`}
              maxLength={1024}
              onChange={(event) => {
                const next = [...values];
                next[index] = event.target.value;
                setValues(next);
                setSendError(undefined);
              }}
              value={value}
            />
          ))}
        </fieldset>
      ) : null}
      {!approved ? (
        <p className={styles.note} data-tone="warning">
          {copy(
            "Only templates approved by Meta can be sent.",
            "אפשר לשלוח רק תבנית ש-Meta אישרה.",
          )}
        </p>
      ) : !supported ? (
        <p className={styles.note} data-tone="warning">
          {templateUnsupportedReason(template.unsupported, he)}
        </p>
      ) : onSend && sendUnavailable ? (
        <p className={styles.note} data-tone="warning">
          {sendUnavailable}
        </p>
      ) : null}
      {sendError ? (
        <p className={styles.note} data-tone="critical" role="alert">
          {sendError}
        </p>
      ) : null}
      {onSend || onSelect ? (
        <div className={styles.actions}>
          {onSelect ? (
            <Button
              disabled={!approved || !supported || sending}
              onClick={() => onSelect(template, parameters)}
              variant="secondary"
            >
              {copy("Insert into reply", "העברה לתיבת התשובה")}
            </Button>
          ) : null}
          {onSend ? (
            <Button
              busy={sending}
              disabled={!usable || sendUnavailable !== undefined}
              onClick={() => {
                setSending(true);
                setSendError(undefined);
                void onSend(template, parameters)
                  .catch((error: unknown) => {
                    setSendError(
                      error instanceof Error && error.message
                        ? error.message
                        : copy(
                            "The template could not be sent.",
                            "לא ניתן היה לשלוח את התבנית.",
                          ),
                    );
                  })
                  .finally(() => setSending(false));
              }}
              title={
                approved && supported && !complete
                  ? copy(
                      "Fill every variable before sending.",
                      "יש למלא את כל המשתנים לפני השליחה.",
                    )
                  : undefined
              }
            >
              <Send aria-hidden="true" size={15} />
              {sending ? copy("Sending…", "שולח…") : copy("Send", "שליחה")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
