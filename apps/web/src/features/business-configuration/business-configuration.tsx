"use client";

import type {
  JsonValue,
  TenantConfiguration,
  TenantConfigurationState,
  TenantFeatureDefinition,
  TenantFeatureKey,
  TenantFeatureSnapshot,
  TenantProcess,
  TenantProcessInput,
  TenantProcessOptions,
  TenantProcessTrigger,
  TenantTemplateKey,
} from "@or-on/crm";
import { configurationFromTemplate } from "@or-on/crm/tenant-configuration-client";
import { parseServiceWorkflowPolicy } from "@or-on/crm/service-workflow";
import {
  Badge,
  Button,
  InlineFeedback,
  Input,
  Select,
  SelectInput,
  Surface,
  Tabs,
  Textarea,
} from "@or-on/ui";
import {
  Check,
  ClipboardCheck,
  FilePenLine,
  Layers3,
  LayoutTemplate,
  Workflow,
} from "lucide-react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { crmMutation } from "../crm";
import styles from "./business-configuration.module.css";
import { FieldOperationsSettings } from "./field-operations-settings";

const triggers: readonly TenantProcessTrigger[] = [
  "whatsapp.new_conversation",
  "whatsapp.message",
  "voice.inbound",
  "voice.outbound_assignment",
  "manual.contact_action",
  "lead.new",
  "service_case.created",
];
const triggerLabels: Record<TenantProcessTrigger, readonly [string, string]> = {
  "whatsapp.new_conversation": [
    "WhatsApp · new conversation",
    "WhatsApp · שיחה חדשה",
  ],
  "whatsapp.message": ["WhatsApp · message", "WhatsApp · הודעה"],
  "voice.inbound": ["Telephone · incoming call", "טלפון · שיחה נכנסת"],
  "voice.outbound_assignment": [
    "Telephone · outgoing call",
    "טלפון · שיחה יוצאת",
  ],
  "manual.contact_action": ["Contact · manual action", "איש קשר · פעולה ידנית"],
  "lead.new": ["Lead · created", "ליד · נוצר"],
  "service_case.created": ["Service incident · created", "אירוע שירות · נוצר"],
};
const intakeFields = [
  ["customerName", "Customer name", "שם הלקוח"],
  ["customerPhone", "Phone number", "מספר טלפון"],
  ["chainName", "Chain", "רשת"],
  ["storeName", "Store / branch", "חנות / סניף"],
  ["serviceLocation", "Service address", "כתובת השירות"],
  ["faultDescription", "Fault description", "תיאור התקלה"],
  ["exactFailure", "What exactly does not work", "מה בדיוק לא עובד"],
  ["warrantyStatus", "Warranty status", "מצב אחריות"],
  ["callbackNumber", "Different callback number", "מספר אחר לחזרה"],
  ["urgency", "Urgency", "דחיפות"],
  ["nationalId", "Identity number", "מספר זהות"],
] as const;
const reportFields = [
  ["diagnosis", "Diagnosis", "אבחון"],
  ["workPerformed", "Work performed", "העבודה שבוצעה"],
  ["partReplaced", "Replaced parts", "חלקים שהוחלפו"],
  ["faultPhoto", "Fault photo", "תמונת התקלה"],
  ["modulePhoto", "Equipment photo", "תמונת הציוד"],
  ["arrivalSignature", "Arrival signature", "חתימה בהגעה"],
  ["departureSignature", "Completion signature", "חתימה בסיום"],
] as const;
type ConfigurationSection =
  "setup" | "modules" | "service" | "processes" | "review" | "history";

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

export function BusinessConfiguration({
  initialFeatures,
  definitions,
  initialProcesses,
  options,
  templates,
  initialGovernance,
}: {
  readonly initialFeatures: TenantFeatureSnapshot;
  readonly definitions: Readonly<
    Record<TenantFeatureKey, TenantFeatureDefinition>
  >;
  readonly initialProcesses: readonly TenantProcess[];
  readonly options: TenantProcessOptions;
  readonly templates: Readonly<
    Record<
      TenantTemplateKey,
      {
        readonly label: string;
        readonly version: number;
        readonly features: readonly TenantFeatureKey[];
      }
    >
  >;
  readonly initialGovernance?: TenantConfigurationState;
}) {
  const locale = useLocale();
  const he = locale.startsWith("he");
  const copy = (en: string, hebrew: string) => (he ? hebrew : en);
  const router = useRouter();
  const fallback: TenantConfiguration = {
    schemaVersion: 1,
    templateKey: null,
    features: Object.values(initialFeatures)
      .filter((feature) => feature.effective)
      .map((feature) => feature.key),
    featureConfiguration: Object.fromEntries(
      Object.values(initialFeatures).map((feature) => [
        feature.key,
        feature.configuration,
      ]),
    ),
    processes: initialProcesses,
  };
  const [governance, setGovernance] = useState(initialGovernance);
  const [draft, setDraft] = useState<TenantConfiguration>(
    initialGovernance?.draft?.configuration ??
      initialGovernance?.active?.configuration ??
      initialGovernance?.initialConfiguration ??
      fallback,
  );
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<string>();
  const [reviewNote, setReviewNote] = useState("");
  const [feedback, setFeedback] = useState<{
    message: string;
    critical: boolean;
  }>();
  const [editIndex, setEditIndex] = useState<number>();
  const [formVersion, setFormVersion] = useState(0);
  const [section, setSection] = useState<ConfigurationSection>("setup");
  const active = governance?.active?.configuration ?? fallback;
  const submitted = governance?.draft?.status === "submitted";
  const locked = pending !== undefined || submitted;
  const workflow = parseServiceWorkflowPolicy(
    draft.featureConfiguration.field_service?.workflow,
  );
  const requiredIntake: readonly string[] = workflow.requiredIntakeFields;
  const requiredReport: readonly string[] = workflow.requiredReportFields;
  const editing =
    editIndex === undefined ? undefined : draft.processes[editIndex];
  const changedFeatures = Object.keys(definitions).filter(
    (key) =>
      draft.features.includes(key as TenantFeatureKey) !==
      active.features.includes(key as TenantFeatureKey),
  );
  const unavailableFeatures = draft.features.filter(
    (key) => !initialFeatures[key].available,
  );
  const enabledProcesses = draft.processes.filter((process) => process.enabled);
  const channelReady = (channel: string) =>
    enabledProcesses.some(
      (process) =>
        process.channel === channel ||
        process.trigger.startsWith(`${channel}.`),
    );

  function versionLabel(item: TenantProcessInput, kind: "agent" | "flow") {
    const id =
      kind === "agent" ? item.agentProfileVersionId : item.flowVersionId;
    const option = (kind === "agent" ? options.agents : options.flows).find(
      (entry) => entry.id === id,
    );
    if (option) return option.label;
    const previous = initialProcesses.find(
      (entry) =>
        (kind === "agent"
          ? entry.agentProfileVersionId
          : entry.flowVersionId) === id,
    );
    const name = kind === "agent" ? previous?.agentName : previous?.flowName;
    const version =
      kind === "agent" ? previous?.agentVersion : previous?.flowVersion;
    if (name) return `${name}${version == null ? "" : ` v${String(version)}`}`;
    return kind === "agent"
      ? copy("Agent not selected", "לא נבחר סוכן")
      : copy("Flow not selected", "לא נבחר תהליך");
  }

  function update(next: TenantConfiguration) {
    setDraft(next);
    setDirty(true);
    setFeedback(undefined);
  }
  function setWorkflow(key: string, value: unknown) {
    // An undefined value removes the optional key, which restores the
    // tenant's previous behaviour for that capability.
    const next: Record<string, unknown> = Object.fromEntries(
      Object.entries({ ...workflow, version: 1, [key]: value } as Record<
        string,
        unknown
      >).filter(([, entry]) => entry !== undefined),
    );
    update({
      ...draft,
      featureConfiguration: {
        ...draft.featureConfiguration,
        field_service: {
          ...draft.featureConfiguration.field_service,
          // Validated again by the parser on render and by the server on save.
          workflow: next as unknown as JsonValue,
        },
      },
    });
  }
  function toggleFeature(key: TenantFeatureKey) {
    const selected = new Set(draft.features);
    if (selected.has(key)) {
      selected.delete(key);
      let removed = true;
      while (removed) {
        removed = false;
        for (const feature of selected)
          if (
            definitions[feature].dependencies.some(
              (dependency) => !selected.has(dependency),
            )
          ) {
            selected.delete(feature);
            removed = true;
          }
      }
    } else {
      const add = (feature: TenantFeatureKey) => {
        if (selected.has(feature)) return;
        selected.add(feature);
        definitions[feature].dependencies.forEach(add);
      };
      add(key);
    }
    update({ ...draft, features: [...selected] });
  }
  function useTemplate(key: TenantTemplateKey) {
    const template = configurationFromTemplate(key);
    update({
      ...template,
      featureConfiguration: {
        ...draft.featureConfiguration,
        ...template.featureConfiguration,
      },
    });
    setEditIndex(undefined);
    setFormVersion((value) => value + 1);
  }
  async function persist(): Promise<TenantConfigurationState> {
    const result = await crmMutation<{
      configuration: TenantConfigurationState;
    }>(
      "/api/settings/business/configuration",
      {
        configuration: draft,
        expectedRevision: governance?.draft?.revision ?? null,
      },
      { method: "PUT" },
    );
    setGovernance(result.configuration);
    setDirty(false);
    return result.configuration;
  }
  async function action(kind: "save" | "submit" | "approve" | "reject") {
    if (pending !== undefined) return;
    setPending(kind);
    setFeedback(undefined);
    try {
      let current = governance;
      if (kind === "save" || (kind === "submit" && (dirty || !current?.draft)))
        current = await persist();
      if (kind !== "save") {
        if (!current?.draft)
          throw new Error(
            copy(
              "Save a draft before requesting review.",
              "יש לשמור טיוטה לפני שליחה לבדיקה.",
            ),
          );
        const result = await crmMutation<{
          configuration: TenantConfigurationState;
        }>(
          "/api/settings/business/configuration",
          {
            action: kind,
            expectedRevision: current.draft.revision,
            note: reviewNote.trim() || undefined,
          },
          { method: "POST" },
        );
        setGovernance(result.configuration);
        setDraft(
          result.configuration.draft?.configuration ??
            result.configuration.active?.configuration ??
            draft,
        );
        setDirty(false);
        setReviewNote("");
      }
      setFeedback({
        critical: false,
        message:
          kind === "approve"
            ? copy(
                "Approved and published. The workspace now uses this configuration.",
                "אושר ופורסם. סביבת העבודה משתמשת כעת בהגדרה זו.",
              )
            : kind === "submit"
              ? copy(
                  "Submitted for platform approval. Your published workspace is unchanged.",
                  "נשלח לאישור מנהל הפלטפורמה. סביבת העבודה הפעילה לא השתנתה.",
                )
              : kind === "reject"
                ? copy(
                    "Returned for changes with your review notes.",
                    "הוחזר לתיקונים עם הערות הבדיקה.",
                  )
                : copy(
                    "Draft saved. Continue configuring or submit it for review.",
                    "הטיוטה נשמרה. ניתן להמשיך בהגדרה או לשלוח לאישור.",
                  ),
      });
      router.refresh();
    } catch (error) {
      setFeedback({
        critical: true,
        message:
          error instanceof Error
            ? error.message
            : copy(
                "Could not update the configuration.",
                "לא ניתן לעדכן את ההגדרה.",
              ),
      });
    } finally {
      setPending(undefined);
    }
  }
  function saveProcess(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const process: TenantProcessInput = {
      name: text(form, "name"),
      purpose: text(form, "purpose"),
      enabled: text(form, "enabled") === "true",
      trigger: text(form, "trigger") as TenantProcessTrigger,
      channel: (text(form, "channel") || null) as
        "whatsapp" | "voice" | "manual" | null,
      businessObject: (text(form, "businessObject") || null) as
        "contact" | "lead" | "ticket" | "service_case" | "appointment" | null,
      agentProfileVersionId: text(form, "agentProfileVersionId") || null,
      flowVersionId: text(form, "flowVersionId") || null,
      priority: Number(text(form, "priority") || 100),
    };
    update({
      ...draft,
      processes:
        editIndex === undefined
          ? [...draft.processes, process]
          : draft.processes.map((item, index) =>
              index === editIndex ? process : item,
            ),
    });
    setEditIndex(undefined);
    setFormVersion((value) => value + 1);
  }

  const statusLabel = dirty
    ? copy("Unsaved changes", "שינויים שלא נשמרו")
    : submitted
      ? copy("Awaiting approval", "ממתין לאישור")
      : governance?.draft
        ? copy("Draft", "טיוטה")
        : governance?.active
          ? copy("Published", "פורסם")
          : copy("Not configured", "טרם הוגדר");
  const statusTone =
    submitted || dirty
      ? "warning"
      : governance?.active
        ? "positive"
        : "neutral";
  const hasHistory = (governance?.history.length ?? 0) > 0;
  const sections: readonly {
    readonly id: ConfigurationSection;
    readonly label: string;
    readonly count?: number;
  }[] = [
    { id: "setup", label: copy("Getting started", "התחלה") },
    {
      id: "modules",
      label: copy("Modules", "מודולים"),
      count: draft.features.length,
    },
    ...(draft.features.includes("field_service")
      ? [
          {
            id: "service" as const,
            label: copy("Service workflow", "תהליך שירות"),
          },
        ]
      : []),
    {
      id: "processes",
      label: copy("Processes", "תהליכים"),
      count: draft.processes.length,
    },
    { id: "review", label: copy("Review & publish", "בדיקה ופרסום") },
    ...(hasHistory
      ? [
          {
            id: "history" as const,
            label: copy("History", "היסטוריה"),
            count: governance?.history.length ?? 0,
          },
        ]
      : []),
  ];
  // A section can disappear (for example Field Service removed from the
  // draft); fall back to the first one instead of showing nothing.
  const currentSection = sections.some((item) => item.id === section)
    ? section
    : "setup";
  const tabItems = sections.map((item) => ({
    controls: `business-configuration-${item.id}-panel`,
    id: item.id,
    label: item.label,
    tabId: `business-configuration-${item.id}-tab`,
    ...(item.count === undefined ? {} : { count: item.count }),
  }));
  const panel = (id: ConfigurationSection) => ({
    "aria-labelledby": `business-configuration-${id}-tab`,
    className: "settings-panel",
    hidden: currentSection !== id,
    id: `business-configuration-${id}-panel`,
    role: "tabpanel",
  });
  const templateLabel =
    Object.entries(templates).find(([key]) => key === draft.templateKey)?.[1]
      .label ?? copy("Custom", "מותאם אישית");

  return (
    <div className="settings-workspace" dir={he ? "rtl" : "ltr"}>
      <section
        aria-label={copy("Configuration at a glance", "סקירת ההגדרה")}
        className="settings-overview"
      >
        <button
          aria-pressed={currentSection === "setup"}
          className="settings-overview-card"
          onClick={() => setSection("setup")}
          type="button"
        >
          <span className="settings-overview-card__icon">
            <LayoutTemplate aria-hidden="true" size={18} />
          </span>
          <span>
            <small>{copy("Starting template", "תבנית בסיס")}</small>
            <strong>{templateLabel}</strong>
            <em>{copy("Tailored below", "מותאמת בהמשך")}</em>
          </span>
        </button>
        <button
          aria-pressed={currentSection === "modules"}
          className="settings-overview-card"
          onClick={() => setSection("modules")}
          type="button"
        >
          <span className="settings-overview-card__icon">
            <Layers3 aria-hidden="true" size={18} />
          </span>
          <span>
            <small>{copy("Modules", "מודולים")}</small>
            <strong>{draft.features.length}</strong>
            <em>{copy("Included in the draft", "כלולים בטיוטה")}</em>
          </span>
        </button>
        <button
          aria-pressed={currentSection === "processes"}
          className="settings-overview-card"
          onClick={() => setSection("processes")}
          type="button"
        >
          <span className="settings-overview-card__icon">
            <Workflow aria-hidden="true" size={18} />
          </span>
          <span>
            <small>{copy("Processes", "תהליכים")}</small>
            <strong>{enabledProcesses.length}</strong>
            <em>{copy("Active after approval", "פעילים לאחר אישור")}</em>
          </span>
        </button>
        <button
          aria-pressed={currentSection === "review"}
          className="settings-overview-card"
          onClick={() => setSection("review")}
          type="button"
        >
          <span className="settings-overview-card__icon">
            <ClipboardCheck aria-hidden="true" size={18} />
          </span>
          <span>
            <small>{copy("Module changes", "שינויי מודולים")}</small>
            <strong>{changedFeatures.length}</strong>
            <em>
              {copy(
                "Compared with the live workspace",
                "לעומת סביבת העבודה הפעילה",
              )}
            </em>
          </span>
        </button>
      </section>
      <aside className="settings-navigation">
        <div className={styles.status}>
          <div>
            <strong>{copy("Configuration status", "מצב ההגדרה")}</strong>
            <Badge label={statusLabel} tone={statusTone} />
          </div>
          <p>
            {submitted
              ? copy(
                  "Awaiting platform approval. Published settings remain active.",
                  "ממתין לאישור מנהל הפלטפורמה. ההגדרות שפורסמו נשארות פעילות.",
                )
              : copy(
                  "Saving a draft does not change the live workspace.",
                  "שמירת טיוטה אינה משנה את סביבת העבודה הפעילה.",
                )}
          </p>
        </div>
        <div className="settings-desktop-navigation">
          <Tabs
            activeId={currentSection}
            ariaLabel={copy("Configuration sections", "חלקי ההגדרה")}
            direction={he ? "rtl" : "ltr"}
            items={tabItems}
            orientation="vertical"
            onChange={(id) => setSection(id as ConfigurationSection)}
          />
        </div>
        <SelectInput
          aria-label={copy("Configuration sections", "חלקי ההגדרה")}
          className="settings-compact-navigation"
          value={currentSection}
          onChange={(event) =>
            setSection(event.target.value as ConfigurationSection)
          }
        >
          {sections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </SelectInput>
        {submitted ? (
          governance.canApprove && currentSection !== "review" ? (
            <div className={styles.navActions}>
              <Button onClick={() => setSection("review")}>
                {copy("Review submission", "בדיקת ההגשה")}
              </Button>
            </div>
          ) : null
        ) : (
          <div className={styles.navActions}>
            <Button
              busy={pending === "save"}
              disabled={pending !== undefined}
              variant="secondary"
              onClick={() => void action("save")}
            >
              {copy("Save draft", "שמירת טיוטה")}
            </Button>
            <Button
              busy={pending === "submit"}
              disabled={pending !== undefined}
              onClick={() => void action("submit")}
            >
              {copy("Submit for approval", "שליחה לאישור")}
            </Button>
          </div>
        )}
      </aside>
      <div className="settings-content">
        {feedback ? (
          <InlineFeedback
            description={feedback.message}
            tone={feedback.critical ? "critical" : "positive"}
          />
        ) : null}
        {governance?.draft?.reviewNotes ? (
          <InlineFeedback
            description={governance.draft.reviewNotes}
            tone="warning"
          />
        ) : null}
        <section {...panel("setup")}>
          <header className="settings-section-title">
            <h2>
              {copy(
                "An approved experience for this business",
                "חוויה מאושרת שמותאמת לעסק",
              )}
            </h2>
            <p>
              {copy(
                "Approve the feature package, prepare the agent and flow, then submit the exact workflow versions for approval. Live channels also require their connection and readiness checks.",
                "מאשרים את חבילת היכולות, מכינים סוכן ותהליך, ואז שולחים את גרסאות התהליך המדויקות לאישור. ערוצים חיים דורשים גם חיבור ובדיקת מוכנות.",
              )}
            </p>
          </header>
          <ol
            className={styles.steps}
            aria-label={copy("Onboarding steps", "שלבי הקמה")}
          >
            <li>
              <Layers3 size={18} aria-hidden="true" />
              <span>{copy("Choose features", "בחירת יכולות")}</span>
            </li>
            <li>
              <FilePenLine size={18} aria-hidden="true" />
              <span>{copy("Configure workflows", "הגדרת תהליכים")}</span>
            </li>
            <li>
              <ClipboardCheck size={18} aria-hidden="true" />
              <span>{copy("Review and approve", "בדיקה ואישור")}</span>
            </li>
            <li>
              <Check size={18} aria-hidden="true" />
              <span>{copy("Publish workspace", "פרסום סביבת העבודה")}</span>
            </li>
          </ol>
          <Surface className={styles.section} level="raised">
            <header className={styles.subheading}>
              <h3>{copy("Business templates", "תבניות עסקיות")}</h3>
              <p>
                {copy(
                  "Choose a reusable starting point, then tailor it. Selecting a template replaces draft features and workflows; publication requires approval.",
                  "בוחרים נקודת התחלה ומתאימים אותה לעסק. בחירת תבנית מחליפה את היכולות והתהליכים בטיוטה; פרסום דורש אישור.",
                )}
              </p>
            </header>
            <div className={styles.templateGrid}>
              {Object.entries(templates).map(([key, template]) => (
                <article
                  className={styles.template}
                  data-selected={draft.templateKey === key}
                  key={key}
                >
                  <h3>{template.label}</h3>
                  <p>
                    {template.features
                      .map((feature) => definitions[feature].label)
                      .join(" · ") ||
                      copy(
                        "Start with a minimal workspace",
                        "מתחילים עם סביבת עבודה בסיסית",
                      )}
                  </p>
                  <Button
                    disabled={locked}
                    variant={
                      draft.templateKey === key ? "primary" : "secondary"
                    }
                    aria-pressed={draft.templateKey === key}
                    onClick={() => useTemplate(key as TenantTemplateKey)}
                  >
                    {draft.templateKey === key
                      ? copy("Selected", "נבחרה")
                      : copy("Use template", "בחירת תבנית")}
                  </Button>
                </article>
              ))}
            </div>
          </Surface>
        </section>
        <section {...panel("modules")}>
          <header className="settings-section-title">
            <h2>{copy("Modules", "מודולים")}</h2>
            <p>
              {copy(
                "Select the tools this tenant needs. Required dependencies are included automatically. Changes take effect only after approval.",
                "בוחרים את הכלים הנחוצים לעסק. יכולות נלוות נדרשות נבחרות אוטומטית. השינויים נכנסים לתוקף רק לאחר אישור.",
              )}
            </p>
          </header>
          <div className={styles.moduleList}>
            {Object.values(definitions).map((definition) => (
              <label
                className={styles.module}
                data-selected={draft.features.includes(definition.key)}
                key={definition.key}
              >
                <div>
                  <div className={styles.moduleTitle}>
                    <h3>{definition.label}</h3>
                    {active.features.includes(definition.key) ? (
                      <Badge label={copy("Live", "פעיל כעת")} tone="positive" />
                    ) : null}
                    {!initialFeatures[definition.key].available ? (
                      <Badge
                        label={copy(
                          "Platform access required",
                          "נדרשת הרשאת פלטפורמה",
                        )}
                        tone="warning"
                      />
                    ) : null}
                  </div>
                  <p>{definition.purpose}</p>
                  <small>
                    {definition.dependencies.length
                      ? `${copy("Requires", "דורש")} ${definition.dependencies.map((key) => definitions[key].label).join(", ")}`
                      : copy("No module dependencies", "ללא תלויות במודולים")}
                  </small>
                </div>
                <input
                  aria-label={`${copy("Enable", "הפעלת")} ${definition.label}`}
                  checked={draft.features.includes(definition.key)}
                  disabled={
                    locked ||
                    definition.key === "contacts" ||
                    !initialFeatures[definition.key].available
                  }
                  type="checkbox"
                  onChange={() => toggleFeature(definition.key)}
                />
              </label>
            ))}
          </div>
        </section>
        {draft.features.includes("field_service") ? (
          <section {...panel("service")}>
            <header className="settings-section-title">
              <h2>
                {copy(
                  "From customer intake to a completed visit",
                  "מפניית לקוח לביקור שהושלם",
                )}
              </h2>
              <p>
                {copy(
                  "Both WhatsApp and telephone use these requirements. Known customer information is reused, and the agent asks only for what is missing.",
                  "WhatsApp והטלפון משתמשים באותן דרישות. פרטי לקוח מוכרים נלקחים מהמערכת, והסוכן מבקש רק את החסר.",
                )}
              </p>
            </header>
            <Surface className={styles.section} level="raised">
              <div className={styles.policyGrid}>
                <fieldset className={styles.fieldset} disabled={locked}>
                  <legend>
                    {copy("Required intake information", "מידע נדרש בקליטה")}
                  </legend>
                  {intakeFields.map(([key, en, hebrew]) => (
                    <label className={styles.check} key={key}>
                      <input
                        type="checkbox"
                        checked={requiredIntake.includes(key)}
                        disabled={key === "faultDescription"}
                        onChange={() =>
                          setWorkflow(
                            "requiredIntakeFields",
                            requiredIntake.includes(key)
                              ? requiredIntake.filter((field) => field !== key)
                              : [...requiredIntake, key],
                          )
                        }
                      />
                      <span>{copy(en, hebrew)}</span>
                    </label>
                  ))}
                </fieldset>
                <fieldset className={styles.fieldset} disabled={locked}>
                  <legend>
                    {copy("Required service report", "מידע נדרש בדוח שירות")}
                  </legend>
                  {reportFields.map(([key, en, hebrew]) => (
                    <label className={styles.check} key={key}>
                      <input
                        type="checkbox"
                        checked={requiredReport.includes(key)}
                        onChange={() =>
                          setWorkflow(
                            "requiredReportFields",
                            requiredReport.includes(key)
                              ? requiredReport.filter((field) => field !== key)
                              : [...requiredReport, key],
                          )
                        }
                      />
                      <span>{copy(en, hebrew)}</span>
                    </label>
                  ))}
                </fieldset>
              </div>
              <Select
                id="workflow-photos"
                label={copy("Photos during intake", "תמונות במהלך הקליטה")}
                disabled={locked}
                value={
                  typeof workflow.photoPolicy === "string"
                    ? workflow.photoPolicy
                    : "requested"
                }
                onChange={(event) =>
                  setWorkflow("photoPolicy", event.target.value)
                }
              >
                <option value="optional">{copy("Optional", "לא חובה")}</option>
                <option value="requested">
                  {copy(
                    "Request photos; allow opening before they arrive",
                    "לבקש תמונות, ולאפשר פתיחת אירוע לפני קבלתן",
                  )}
                </option>
                <option value="required">
                  {copy(
                    "Require photos before opening",
                    "לחייב תמונות לפני פתיחת האירוע",
                  )}
                </option>
              </Select>
              <label className={styles.check}>
                <input
                  checked={workflow.selfAssignmentEnabled}
                  disabled={locked}
                  type="checkbox"
                  onChange={(event) =>
                    setWorkflow("selfAssignmentEnabled", event.target.checked)
                  }
                />
                <span>
                  {copy(
                    "Allow eligible technicians to take available incidents",
                    "לאפשר לטכנאים מורשים לקחת אירועים זמינים לטיפולם",
                  )}
                </span>
              </label>
            </Surface>
            <Surface className={styles.section} level="raised">
              <FieldOperationsSettings
                he={he}
                locked={locked}
                onChange={setWorkflow}
                workflow={workflow}
              />
            </Surface>
          </section>
        ) : null}
        <section {...panel("processes")}>
          <header className="settings-section-title">
            <h2>{copy("Processes", "תהליכים")}</h2>
            <p>
              {copy(
                "Bind each customer event to published agent and workflow versions. Saving here updates the draft; the active configuration remains in use until approval.",
                "משייכים אירועי לקוח לגרסאות שפורסמו של סוכן ותהליך. השמירה מעדכנת את הטיוטה; ההגדרה הפעילה נשארת בתוקף עד לאישור.",
              )}
            </p>
          </header>
          <Surface className={styles.section} level="raised">
            <div className={styles.processList}>
              {draft.processes.length === 0 ? (
                <p className={styles.empty}>
                  {copy(
                    "No processes configured yet. Approve features first, then prepare and bind your agent and flow.",
                    "טרם הוגדרו תהליכים. מאשרים יכולות, ואז מכינים ומשייכים סוכן ותהליך.",
                  )}
                </p>
              ) : (
                draft.processes.map((item, index) => (
                  <article
                    className={styles.process}
                    key={`${String(index)}:${item.name}`}
                  >
                    <div>
                      <div className={styles.moduleTitle}>
                        <h3 dir="auto">{item.name}</h3>
                        <Badge
                          label={
                            item.enabled
                              ? copy("Included", "כלול")
                              : copy("Inactive", "לא פעיל")
                          }
                          tone={item.enabled ? "positive" : "neutral"}
                        />
                      </div>
                      <p>
                        {triggerLabels[item.trigger][he ? 1 : 0]} ·{" "}
                        {copy("Priority", "עדיפות")} {item.priority ?? 100}
                      </p>
                      <small>
                        {versionLabel(item, "agent")} →{" "}
                        {versionLabel(item, "flow")}
                      </small>
                    </div>
                    <div className={styles.actions}>
                      <Button
                        disabled={locked}
                        variant="secondary"
                        onClick={() => {
                          setEditIndex(index);
                          setFormVersion((value) => value + 1);
                        }}
                      >
                        {copy("Edit", "עריכה")}
                      </Button>
                      <Button
                        disabled={locked}
                        variant="quiet"
                        onClick={() =>
                          update({
                            ...draft,
                            processes: draft.processes.filter(
                              (_, position) => position !== index,
                            ),
                          })
                        }
                      >
                        {copy("Remove from draft", "הסרה מהטיוטה")}
                      </Button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </Surface>
          <Surface className={styles.section} level="raised">
            <form
              className={styles.form}
              key={formVersion}
              onSubmit={saveProcess}
            >
              <h3>
                {editIndex === undefined
                  ? copy("Create process", "יצירת תהליך")
                  : copy("Edit process", "עריכת תהליך")}
              </h3>
              <Input
                id="process-name"
                label={copy("Name", "שם")}
                name="name"
                defaultValue={editing?.name ?? ""}
                disabled={locked}
                required
              />
              <Input
                id="process-purpose"
                label={copy("Purpose", "מטרה")}
                name="purpose"
                defaultValue={editing?.purpose ?? ""}
                disabled={locked}
              />
              <Select
                id="process-trigger"
                label={copy("Customer event", "אירוע לקוח")}
                name="trigger"
                defaultValue={editing?.trigger ?? "manual.contact_action"}
                disabled={locked}
              >
                {triggers.map((trigger) => (
                  <option key={trigger} value={trigger}>
                    {triggerLabels[trigger][he ? 1 : 0]}
                  </option>
                ))}
              </Select>
              <Select
                id="process-channel"
                label={copy("Channel", "ערוץ")}
                name="channel"
                defaultValue={editing?.channel ?? ""}
                disabled={locked}
              >
                <option value="">
                  {copy("Any compatible channel", "כל ערוץ תואם")}
                </option>
                <option value="manual">{copy("Manual", "ידני")}</option>
                {draft.features.includes("whatsapp") ? (
                  <option value="whatsapp">WhatsApp</option>
                ) : null}
                {draft.features.includes("voice") ? (
                  <option value="voice">{copy("Telephone", "טלפון")}</option>
                ) : null}
              </Select>
              <Select
                id="process-object"
                label={copy("Business outcome", "תוצאה עסקית")}
                name="businessObject"
                defaultValue={editing?.businessObject ?? ""}
                disabled={locked}
              >
                <option value="">
                  {copy("No record required", "ללא רשומה חדשה")}
                </option>
                <option value="contact">{copy("Contact", "איש קשר")}</option>
                {draft.features.includes("leads") ? (
                  <option value="lead">{copy("Lead", "ליד")}</option>
                ) : null}
                {draft.features.includes("tickets") ? (
                  <option value="ticket">
                    {copy("Support ticket", "פניית תמיכה")}
                  </option>
                ) : null}
                {draft.features.includes("field_service") ? (
                  <option value="service_case">
                    {copy("Service incident", "אירוע שירות")}
                  </option>
                ) : null}
                {draft.features.includes("appointments") ? (
                  <option value="appointment">
                    {copy("Appointment", "פגישה")}
                  </option>
                ) : null}
              </Select>
              <Select
                id="process-agent"
                label={copy("Published agent", "סוכן שפורסם")}
                name="agentProfileVersionId"
                defaultValue={editing?.agentProfileVersionId ?? ""}
                disabled={locked}
              >
                <option value="">
                  {copy("Choose an agent", "בחירת סוכן")}
                </option>
                {options.agents.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label} · {option.channels.join(" / ")}
                  </option>
                ))}
              </Select>
              <Select
                id="process-flow"
                label={copy("Published workflow", "תהליך שפורסם")}
                name="flowVersionId"
                defaultValue={editing?.flowVersionId ?? ""}
                disabled={locked}
              >
                <option value="">
                  {copy("Choose a workflow", "בחירת תהליך")}
                </option>
                {options.flows.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label} · {option.channels.join(" / ")}
                  </option>
                ))}
              </Select>
              <Input
                id="process-priority"
                label={copy(
                  "Priority (lower runs first)",
                  "עדיפות (מספר נמוך מופעל קודם)",
                )}
                name="priority"
                type="number"
                min={0}
                max={10000}
                defaultValue={editing?.priority ?? 100}
                disabled={locked}
              />
              <Select
                id="process-enabled"
                label={copy("After approval", "לאחר אישור")}
                name="enabled"
                defaultValue={editing?.enabled ? "true" : "false"}
                disabled={locked}
              >
                <option value="false">
                  {copy("Keep inactive", "לשמור כלא פעיל")}
                </option>
                <option value="true">
                  {copy("Activate this process", "להפעיל את התהליך")}
                </option>
              </Select>
              <div className={styles.actions}>
                <Button type="submit" disabled={locked}>
                  {editIndex === undefined
                    ? copy("Add to draft", "הוספה לטיוטה")
                    : copy("Update draft process", "עדכון התהליך בטיוטה")}
                </Button>
                {editIndex !== undefined ? (
                  <Button
                    type="button"
                    variant="quiet"
                    onClick={() => {
                      setEditIndex(undefined);
                      setFormVersion((value) => value + 1);
                    }}
                  >
                    {copy("Cancel editing", "ביטול עריכה")}
                  </Button>
                ) : null}
              </div>
            </form>
          </Surface>
        </section>
        <section {...panel("review")}>
          <header className="settings-section-title">
            <h2>
              {copy("Review the customer experience", "בדיקת חוויית הלקוח")}
            </h2>
            <p>
              {`${String(draft.features.length)} ${copy("features", "יכולות")} · ${String(enabledProcesses.length)} ${copy("active processes", "תהליכים פעילים")}`}
            </p>
          </header>
          <Surface className={styles.section} level="raised">
            <div className={styles.previewGrid}>
              <div>
                <h3>
                  {copy("Workspace preview", "תצוגה מקדימה של סביבת העבודה")}
                </h3>
                <ul>
                  {draft.features.map((key) => (
                    <li key={key}>{definitions[key].label}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>{copy("Conversation readiness", "מוכנות שיחות")}</h3>
                {(["whatsapp", "voice"] as const)
                  .filter((channel) => draft.features.includes(channel))
                  .map((channel) => (
                    <p key={channel}>
                      {channel === "whatsapp"
                        ? "WhatsApp"
                        : copy("Telephone", "טלפון")}{" "}
                      ·{" "}
                      {channelReady(channel)
                        ? copy(
                            "Workflow included; verify connection before live use",
                            "תהליך כלול; יש לבדוק חיבור לפני שימוש חי",
                          )
                        : copy("Workflow not configured", "טרם הוגדר תהליך")}
                    </p>
                  ))}
                {!draft.features.includes("whatsapp") &&
                !draft.features.includes("voice") ? (
                  <p>
                    {copy(
                      "No conversation channels are included in this package.",
                      "חבילה זו אינה כוללת ערוצי שיחה.",
                    )}
                  </p>
                ) : null}
                <p>
                  {copy("Feature changes", "שינויי יכולות")}:{" "}
                  {changedFeatures.length
                    ? changedFeatures
                        .map(
                          (key) =>
                            `${draft.features.includes(key as TenantFeatureKey) ? "+" : "−"} ${definitions[key as TenantFeatureKey].label}`,
                        )
                        .join(" · ")
                    : copy("No change", "ללא שינוי")}
                </p>
              </div>
            </div>
            {unavailableFeatures.length ? (
              <InlineFeedback
                description={`${copy("Platform access must be granted before this package can be published", "נדרשת הענקת גישה על ידי מנהל הפלטפורמה לפני פרסום החבילה")}: ${unavailableFeatures.map((key) => definitions[key].label).join(", ")}. ${copy("Contact the platform administrator; selecting a template does not grant module access.", "יש לפנות למנהל הפלטפורמה; בחירת תבנית אינה מעניקה גישה למודולים.")}`}
                tone="warning"
              />
            ) : null}
            {submitted && governance.canApprove ? (
              <>
                <Textarea
                  id="configuration-review-notes"
                  label={copy("Review notes", "הערות בדיקה")}
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                  rows={3}
                />
                <div className={styles.publishBar}>
                  <p>
                    {copy(
                      "Approving publishes this revision to the live workspace.",
                      "האישור מפרסם גרסה זו לסביבת העבודה הפעילה.",
                    )}
                  </p>
                  <div className={styles.actions}>
                    <Button
                      disabled={pending !== undefined || !reviewNote.trim()}
                      variant="secondary"
                      onClick={() => void action("reject")}
                    >
                      {copy("Return for changes", "החזרה לתיקונים")}
                    </Button>
                    <Button
                      busy={pending === "approve"}
                      disabled={
                        pending !== undefined || unavailableFeatures.length > 0
                      }
                      onClick={() => void action("approve")}
                    >
                      {copy("Approve & publish", "אישור ופרסום")}
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <p className={styles.hint}>
                {submitted
                  ? copy(
                      "This draft is awaiting platform approval. Published settings remain active.",
                      "הטיוטה ממתינה לאישור מנהל הפלטפורמה. ההגדרות שפורסמו נשארות פעילות.",
                    )
                  : copy(
                      "When the draft is ready, submit it for approval from the side panel.",
                      "כשהטיוטה מוכנה, שולחים אותה לאישור מהחלונית הצדדית.",
                    )}
              </p>
            )}
          </Surface>
        </section>
        {hasHistory ? (
          <section {...panel("history")}>
            <header className="settings-section-title">
              <h2>{copy("Configuration history", "היסטוריית הגדרות")}</h2>
              <p>
                {copy(
                  "Every submitted, returned and published revision.",
                  "כל הגרסאות שנשלחו, הוחזרו ופורסמו.",
                )}
              </p>
            </header>
            <Surface className={styles.section} level="raised">
              <ol className={styles.history}>
                {governance?.history.map((release) => (
                  <li key={release.id}>
                    <div>
                      <strong>
                        {copy("Version", "גרסה")} {release.version}
                      </strong>
                      <p>
                        {release.approvedAt
                          ? new Intl.DateTimeFormat(locale, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(new Date(release.approvedAt))
                          : new Intl.DateTimeFormat(locale, {
                              dateStyle: "medium",
                            }).format(new Date(release.createdAt))}
                      </p>
                      {release.reviewNotes ? (
                        <p dir="auto">{release.reviewNotes}</p>
                      ) : null}
                    </div>
                    <Badge
                      label={
                        release.status === "published"
                          ? copy("Published", "פורסם")
                          : release.status === "submitted"
                            ? copy("Awaiting approval", "ממתין לאישור")
                            : release.status === "rejected"
                              ? copy("Returned", "הוחזר")
                              : copy("Draft", "טיוטה")
                      }
                      tone={
                        release.status === "published" ? "positive" : "neutral"
                      }
                    />
                  </li>
                ))}
              </ol>
            </Surface>
          </section>
        ) : null}
      </div>
    </div>
  );
}
