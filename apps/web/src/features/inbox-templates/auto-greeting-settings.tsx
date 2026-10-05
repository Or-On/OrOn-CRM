"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { WhatsAppAutoGreeting } from "@or-on/crm";
import { Badge, Button, Checkbox, Select } from "@or-on/ui";
import { crmMutation, crmRead } from "../crm";
import type { WhatsAppTemplate, WhatsAppTemplatePage } from "./catalog";
import { templateLanguageName } from "./template-labels";
import styles from "./auto-greeting-settings.module.css";

interface GreetingState {
  readonly greeting: WhatsAppAutoGreeting | null;
  readonly canManage: boolean;
}

/** Approved variants without variables are the only ones sent unattended. */
function eligible(template: WhatsAppTemplate): boolean {
  return template.status === "APPROVED" && template.draft?.parameterCount === 0;
}

async function loadCatalog(
  conversationId: string,
  signal: AbortSignal,
): Promise<readonly WhatsAppTemplate[]> {
  const templates: WhatsAppTemplate[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const result: WhatsAppTemplatePage = await crmRead<WhatsAppTemplatePage>(
      `/api/messaging/conversations/${encodeURIComponent(conversationId)}/templates${after === null ? "" : `?after=${encodeURIComponent(after)}`}`,
      signal,
    );
    templates.push(...result.templates);
    if (result.after === null) break;
    after = result.after;
  }
  return templates;
}

export function AutoGreetingSettings({
  conversationId,
  locale,
}: {
  readonly conversationId: string;
  readonly locale: string;
}) {
  const he = locale.startsWith("he");
  const copy = (en: string, hebrew: string) => (he ? hebrew : en);
  const [state, setState] = useState<GreetingState>();
  const [templates, setTemplates] = useState<readonly WhatsAppTemplate[]>();
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [fallbackLanguage, setFallbackLanguage] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      crmRead<GreetingState>(
        `/api/messaging/conversations/${encodeURIComponent(conversationId)}/auto-greeting`,
        abort.signal,
      ),
      loadCatalog(conversationId, abort.signal),
    ])
      .then(([greetingState, catalog]) => {
        if (abort.signal.aborted) return;
        setState(greetingState);
        setTemplates(catalog);
        setEnabled(greetingState.greeting?.enabled === true);
        setTemplateName(greetingState.greeting?.templateName ?? "");
        setFallbackLanguage(greetingState.greeting?.fallbackLanguage ?? "");
        setLoadError(false);
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoadError(true);
      });
    return () => abort.abort();
  }, [conversationId, attempt]);

  const options = useMemo(() => {
    const byName = new Map<string, WhatsAppTemplate[]>();
    for (const template of templates ?? [])
      if (eligible(template))
        byName.set(template.name, [
          ...(byName.get(template.name) ?? []),
          template,
        ]);
    return [...byName.entries()]
      .map(([name, variants]) => ({
        name,
        variants: variants.toSorted((left, right) =>
          left.language.localeCompare(right.language),
        ),
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }, [templates]);

  const chosen = options.find((option) => option.name === templateName);
  const languages = chosen?.variants.map((variant) => variant.language) ?? [];
  const defaultLanguage = languages.includes(fallbackLanguage)
    ? fallbackLanguage
    : (languages.find((language) => language.startsWith(he ? "he" : "en")) ??
      languages[0] ??
      "");
  const current = state?.greeting ?? null;
  const canManage = state?.canManage === true;

  async function save() {
    setSaving(true);
    setSaveError(undefined);
    setSaved(false);
    try {
      const result = await crmMutation<GreetingState>(
        `/api/messaging/conversations/${encodeURIComponent(conversationId)}/auto-greeting`,
        { enabled, templateName, fallbackLanguage: defaultLanguage },
        { method: "PUT" },
      );
      setState({ greeting: result.greeting, canManage: true });
      setSaved(true);
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : copy("The setting was not saved.", "ההגדרה לא נשמרה."),
      );
    } finally {
      setSaving(false);
    }
  }

  if (loadError)
    return (
      <div className={styles.panel} role="alert">
        <p>
          {copy(
            "The automatic greeting settings are currently unavailable.",
            "לא ניתן לטעון כעת את הגדרות השליחה האוטומטית.",
          )}
        </p>
        <Button
          onClick={() => setAttempt((value) => value + 1)}
          size="small"
          variant="secondary"
        >
          {copy("Try again", "נסה שוב")}
        </Button>
      </div>
    );
  if (state === undefined || templates === undefined)
    return (
      <p className={styles.loading} role="status">
        {copy("Loading…", "טוען…")}
      </p>
    );

  const unchanged =
    enabled === (current?.enabled === true) &&
    (!enabled ||
      (templateName === current?.templateName &&
        defaultLanguage === current.fallbackLanguage));

  return (
    <section
      aria-label={copy("Automatic greeting", "שליחה אוטומטית")}
      className={styles.panel}
    >
      <div className={styles.summary}>
        <span aria-hidden="true" className={styles.icon}>
          <Sparkles size={18} />
        </span>
        <div>
          <h3>
            {copy(
              "Greet every new conversation automatically",
              "פתיחה אוטומטית לכל שיחה חדשה",
            )}
          </h3>
          <p>
            {copy(
              "When a customer starts a new WhatsApp conversation, the approved template is sent right away in the language the customer wrote in. A conversation is new on the customer's first message, or when nobody has written for 24 hours.",
              "כשלקוח פותח שיחה חדשה ב-WhatsApp, התבנית המאושרת נשלחת אליו מיד, בשפה שבה כתב. שיחה נחשבת חדשה בהודעה הראשונה של הלקוח, או אחרי 24 שעות ללא התכתבות.",
            )}
          </p>
        </div>
        <Badge
          label={
            current?.enabled === true ? copy("On", "פעיל") : copy("Off", "כבוי")
          }
          tone={current?.enabled === true ? "positive" : "neutral"}
        />
      </div>
      {current?.enabled === true ? (
        <p className={styles.current}>
          {copy("Now sending", "נשלחת כעת")}{" "}
          <strong dir="ltr">{current.templateName}</strong> ·{" "}
          {current.languages
            .map((language) => templateLanguageName(language, locale))
            .join(", ")}
        </p>
      ) : null}
      <fieldset className={styles.form} disabled={!canManage || saving}>
        <Checkbox
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            setSaved(false);
          }}
        >
          {copy("Send the template automatically", "לשלוח את התבנית אוטומטית")}
        </Checkbox>
        <Select
          id={`auto-greeting-template-${conversationId}`}
          label={copy("Template", "תבנית")}
          onChange={(event) => {
            setTemplateName(event.target.value);
            setSaved(false);
          }}
          value={chosen === undefined ? "" : templateName}
        >
          <option value="">{copy("Choose a template", "בחרו תבנית")}</option>
          {options.map((option) => (
            <option key={option.name} value={option.name}>
              {option.name} ·{" "}
              {option.variants
                .map((variant) =>
                  templateLanguageName(variant.language, locale),
                )
                .join(", ")}
            </option>
          ))}
        </Select>
        {languages.length > 1 ? (
          <Select
            id={`auto-greeting-language-${conversationId}`}
            label={copy(
              "Language when the customer's language is unclear",
              "שפה כשלא ברור באיזו שפה הלקוח כתב",
            )}
            onChange={(event) => {
              setFallbackLanguage(event.target.value);
              setSaved(false);
            }}
            value={defaultLanguage}
          >
            {languages.map((language) => (
              <option key={language} value={language}>
                {templateLanguageName(language, locale)}
              </option>
            ))}
          </Select>
        ) : null}
        {chosen === undefined ? null : (
          <ul className={styles.variants}>
            {chosen.variants.map((variant) => (
              <li key={variant.id}>
                <span className={styles.variantLanguage}>
                  {templateLanguageName(variant.language, locale)}
                </span>
                <span className={styles.variantText} dir="auto">
                  {variant.body ?? variant.preview}
                </span>
              </li>
            ))}
          </ul>
        )}
        {options.length === 0 ? (
          <p className={styles.note}>
            {copy(
              "No template can be sent automatically yet. Create a template without variables in WhatsApp Manager and wait for Meta's approval.",
              "עדיין אין תבנית שאפשר לשלוח אוטומטית. צרו ב-WhatsApp Manager תבנית ללא משתנים והמתינו לאישור של Meta.",
            )}
          </p>
        ) : (
          <p className={styles.hint}>
            {copy(
              "Only approved templates without variables are listed, because nobody fills them in before sending.",
              "מוצגות רק תבניות מאושרות ללא משתנים, כי אף אחד לא ממלא אותן לפני השליחה.",
            )}
          </p>
        )}
      </fieldset>
      {!canManage ? (
        <p className={styles.note}>
          {copy(
            "Only workspace administrators can change this setting.",
            "רק מנהלי סביבת העבודה יכולים לשנות הגדרה זו.",
          )}
        </p>
      ) : null}
      {saveError ? (
        <p className={styles.error} role="alert">
          {saveError}
        </p>
      ) : null}
      {saved ? (
        <p className={styles.success} role="status">
          {copy("Saved.", "נשמר.")}
        </p>
      ) : null}
      {canManage ? (
        <div className={styles.actions}>
          <Button
            busy={saving}
            disabled={unchanged || (enabled && chosen === undefined)}
            onClick={() => void save()}
          >
            {copy("Save", "שמירה")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
