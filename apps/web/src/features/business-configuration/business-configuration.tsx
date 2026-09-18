"use client";

import type {
  TenantFeatureDefinition,
  TenantFeatureKey,
  TenantFeatureSnapshot,
  TenantProcess,
  TenantProcessOptions,
  TenantProcessTrigger,
  TenantTemplateKey,
} from "@or-on/crm";
import {
  Badge,
  Button,
  InlineFeedback,
  Input,
  Select,
  Surface,
} from "@or-on/ui";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import { crmMutation } from "../crm";
import styles from "./business-configuration.module.css";

const templateKeys: readonly TenantTemplateKey[] = [
  "field_service",
  "lead_generation",
  "customer_support",
  "blank",
];
const englishTriggerLabels: Readonly<Record<TenantProcessTrigger, string>> = {
  "whatsapp.new_conversation": "WhatsApp · new conversation",
  "whatsapp.message": "WhatsApp · message",
  "voice.inbound": "Voice · inbound call",
  "voice.outbound_assignment": "Voice · outbound assignment",
  "manual.contact_action": "Contact · manual action",
  "lead.new": "Lead · created",
  "service_case.created": "Service case · created",
};
const hebrewTriggerLabels: Readonly<Record<TenantProcessTrigger, string>> = {
  "whatsapp.new_conversation": "WhatsApp · שיחה חדשה",
  "whatsapp.message": "WhatsApp · הודעה",
  "voice.inbound": "קול · שיחה נכנסת",
  "voice.outbound_assignment": "קול · שיוך שיחה יוצאת",
  "manual.contact_action": "איש קשר · פעולה ידנית",
  "lead.new": "ליד · נוצר",
  "service_case.created": "קריאת שירות · נוצרה",
};

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

export function BusinessConfiguration({
  initialFeatures,
  definitions,
  initialProcesses,
  options,
  templates,
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
}) {
  const locale = useLocale();
  const he = locale.startsWith("he");
  const triggerLabels = he ? hebrewTriggerLabels : englishTriggerLabels;
  const copy = he
    ? {
        startingPoint: "נקודת התחלה",
        templates: "תבניות עסקיות",
        templatesHint:
          "תבניות מאתחלות מודולים פעם אחת, אינן מפעילות ספקים חיים ואינן דורסות בחירות ידניות מאוחרות יותר.",
        applying: "מחיל…",
        apply: "החלת תבנית",
        workspace: "סביבת העבודה",
        modules: "מודולים",
        modulesHint:
          "נתונים במודולים מושבתים נשמרים, אך פעולות חדשות בממשק, ב-API, בסוכנים ובעובדים נדחות.",
        enabled: "פעיל",
        disabled: "מושבת",
        noDependencies: "ללא תלויות במודולים",
        requires: "דורש",
        saving: "שומר…",
        disable: "השבתה",
        enable: "הפעלה",
        routing: "ניתוב תפעולי",
        processes: "תהליכים",
        processesHint:
          "כל שיוך פעיל מצמיד גרסת סוכן וגרסת תהליך שנבדקו. סדר העדיפויות מפורש.",
        noProcesses: "עדיין לא הוגדרו תהליכים.",
        active: "פעיל",
        inactive: "לא פעיל",
        priority: "עדיפות",
        noAgent: "ללא סוכן",
        noFlow: "ללא Flow",
        noObject: "ללא אובייקט עסקי",
        createProcess: "יצירת תהליך",
        name: "שם",
        purpose: "מטרה",
        trigger: "טריגר",
        channel: "ערוץ",
        anyChannel: "כל ערוץ תואם",
        manual: "ידני",
        businessObject: "אובייקט עסקי",
        none: "ללא",
        publishedAgent: "סוכן שפורסם",
        chooseAgent: "בחירת סוכן",
        publishedFlow: "Flow שפורסם",
        chooseFlow: "בחירת Flow",
        priorityLabel: "עדיפות (מספר נמוך מופעל ראשון)",
        initialStatus: "מצב התחלתי",
        draft: "טיוטה / לא פעיל",
        creating: "יוצר…",
      }
    : {
        startingPoint: "Starting point",
        templates: "Business templates",
        templatesHint:
          "Templates initialize modules once. They never enable live providers and never overwrite later operator choices.",
        applying: "Applying…",
        apply: "Apply template",
        workspace: "Workspace surface",
        modules: "Modules",
        modulesHint:
          "Disabled modules remain preserved but reject new UI, API, agent and worker operations.",
        enabled: "Enabled",
        disabled: "Disabled",
        noDependencies: "No module dependencies",
        requires: "Requires",
        saving: "Saving…",
        disable: "Disable",
        enable: "Enable",
        routing: "Operational routing",
        processes: "Processes",
        processesHint:
          "Each active binding pins a reviewed Agent and Flow version. Priority is explicit.",
        noProcesses: "No processes configured yet.",
        active: "Active",
        inactive: "Inactive",
        priority: "priority",
        noAgent: "No agent",
        noFlow: "No flow",
        noObject: "no business object",
        createProcess: "Create process",
        name: "Name",
        purpose: "Purpose",
        trigger: "Trigger",
        channel: "Channel",
        anyChannel: "Any compatible channel",
        manual: "Manual",
        businessObject: "Business object",
        none: "None",
        publishedAgent: "Published agent",
        chooseAgent: "Choose an agent",
        publishedFlow: "Published flow",
        chooseFlow: "Choose a flow",
        priorityLabel: "Priority (lower runs first)",
        initialStatus: "Initial status",
        draft: "Draft / inactive",
        creating: "Creating…",
      };
  const router = useRouter();
  const [features, setFeatures] = useState(initialFeatures);
  const [processes, setProcesses] = useState(initialProcesses);
  const [pending, setPending] = useState<string>();
  const [feedback, setFeedback] = useState<{
    message: string;
    critical: boolean;
  }>();

  async function changeFeature(key: TenantFeatureKey) {
    const current = features[key];
    setPending(`feature:${key}`);
    setFeedback(undefined);
    try {
      const result = await crmMutation<{
        feature: TenantFeatureSnapshot[TenantFeatureKey];
      }>(
        "/api/settings/business/modules",
        {
          key,
          enabled: !current.effective,
          expectedRevision: current.revision,
        },
        { method: "PATCH" },
      );
      setFeatures((value) => ({ ...value, [key]: result.feature }));
      router.refresh();
      setFeedback({
        critical: false,
        message: he ? "המודול עודכן." : "Module updated.",
      });
    } catch (error) {
      setFeedback({
        critical: true,
        message:
          error instanceof Error
            ? error.message
            : "Module could not be updated.",
      });
    } finally {
      setPending(undefined);
    }
  }

  async function applyTemplate(key: TenantTemplateKey) {
    setPending(`template:${key}`);
    setFeedback(undefined);
    try {
      const result = await crmMutation<{ features: TenantFeatureSnapshot }>(
        "/api/settings/business/templates",
        { key },
        { method: "POST" },
      );
      setFeatures(result.features);
      router.refresh();
      setFeedback({
        critical: false,
        message: he
          ? "התבנית הוחלה. התאמות ידניות נשמרו."
          : "Template applied. Existing operator customizations were preserved.",
      });
    } catch (error) {
      setFeedback({
        critical: true,
        message:
          error instanceof Error
            ? error.message
            : "Template could not be applied.",
      });
    } finally {
      setPending(undefined);
    }
  }

  async function createProcess(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPending("process:new");
    setFeedback(undefined);
    try {
      const channel = formText(form, "channel");
      const object = formText(form, "businessObject");
      const agentProfileVersionId = formText(form, "agentProfileVersionId");
      const flowVersionId = formText(form, "flowVersionId");
      const result = await crmMutation<{ process: TenantProcess }>(
        "/api/settings/business/processes",
        {
          name: form.get("name"),
          purpose: form.get("purpose"),
          enabled: form.get("enabled") === "true",
          trigger: form.get("trigger"),
          channel: channel === "" ? null : channel,
          businessObject: object === "" ? null : object,
          agentProfileVersionId:
            agentProfileVersionId === "" ? null : agentProfileVersionId,
          flowVersionId: flowVersionId === "" ? null : flowVersionId,
          priority: Number(form.get("priority") ?? 100),
        },
        { method: "POST" },
      );
      setProcesses((value) =>
        [...value, result.process].sort((a, b) => a.priority - b.priority),
      );
      formElement.reset();
      setFeedback({
        critical: false,
        message: he ? "התהליך נוצר." : "Process created.",
      });
    } catch (error) {
      setFeedback({
        critical: true,
        message:
          error instanceof Error
            ? error.message
            : "Process could not be created.",
      });
    } finally {
      setPending(undefined);
    }
  }

  async function toggleProcess(item: TenantProcess) {
    setPending(`process:${item.id}`);
    setFeedback(undefined);
    try {
      const result = await crmMutation<{ process: TenantProcess }>(
        `/api/settings/business/processes/${item.id}`,
        {
          name: item.name,
          purpose: item.purpose,
          enabled: !item.enabled,
          trigger: item.trigger,
          channel: item.channel,
          businessObject: item.businessObject,
          agentProfileVersionId: item.agentProfileVersionId,
          flowVersionId: item.flowVersionId,
          requiredFeatures: item.requiredFeatures,
          priority: item.priority,
          expectedRevision: item.revision,
        },
        { method: "PATCH" },
      );
      setProcesses((value) =>
        value.map((entry) => (entry.id === item.id ? result.process : entry)),
      );
      setFeedback({
        critical: false,
        message: he ? "התהליך עודכן." : "Process updated.",
      });
    } catch (error) {
      setFeedback({
        critical: true,
        message:
          error instanceof Error
            ? error.message
            : "Process could not be updated.",
      });
    } finally {
      setPending(undefined);
    }
  }

  return (
    <div className={styles.stack} dir={he ? "rtl" : "ltr"}>
      {feedback === undefined ? null : (
        <InlineFeedback
          description={feedback.message}
          tone={feedback.critical ? "critical" : "positive"}
        />
      )}
      <Surface className={styles.section} level="raised">
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>{copy.startingPoint}</p>
            <h2>{copy.templates}</h2>
          </div>
          <p>{copy.templatesHint}</p>
        </div>
        <div className={styles.templateGrid}>
          {templateKeys.map((key) => (
            <article className={styles.template} key={key}>
              <h3>{templates[key].label}</h3>
              <p>
                {templates[key].features
                  .map((feature) => definitions[feature].label)
                  .join(" · ")}
              </p>
              <Button
                disabled={pending !== undefined}
                onClick={() => void applyTemplate(key)}
                type="button"
              >
                {pending === `template:${key}` ? copy.applying : copy.apply}
              </Button>
            </article>
          ))}
        </div>
      </Surface>

      <Surface className={styles.section} level="raised">
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>{copy.workspace}</p>
            <h2>{copy.modules}</h2>
          </div>
          <p>{copy.modulesHint}</p>
        </div>
        <div className={styles.moduleList}>
          {Object.values(definitions).map((definition) => {
            const state = features[definition.key];
            return (
              <article className={styles.module} key={definition.key}>
                <div>
                  <div className={styles.moduleTitle}>
                    <h3>{definition.label}</h3>
                    <Badge
                      label={state.effective ? copy.enabled : copy.disabled}
                      tone={state.effective ? "positive" : "neutral"}
                    />
                  </div>
                  <p>{definition.purpose}</p>
                  <small>
                    {definition.dependencies.length === 0
                      ? copy.noDependencies
                      : `${copy.requires} ${definition.dependencies.map((key) => definitions[key].label).join(", ")}`}
                  </small>
                </div>
                <Button
                  disabled={pending !== undefined || !state.available}
                  onClick={() => void changeFeature(definition.key)}
                  type="button"
                  variant="secondary"
                >
                  {pending === `feature:${definition.key}`
                    ? copy.saving
                    : state.effective
                      ? copy.disable
                      : copy.enable}
                </Button>
              </article>
            );
          })}
        </div>
      </Surface>

      <Surface className={styles.section} level="raised">
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>{copy.routing}</p>
            <h2>{copy.processes}</h2>
          </div>
          <p>{copy.processesHint}</p>
        </div>
        <div className={styles.processList}>
          {processes.length === 0 ? (
            <p className={styles.empty}>{copy.noProcesses}</p>
          ) : (
            processes.map((item) => (
              <article className={styles.process} key={item.id}>
                <div>
                  <div className={styles.moduleTitle}>
                    <h3>{item.name}</h3>
                    <Badge
                      label={item.enabled ? copy.active : copy.inactive}
                      tone={item.enabled ? "positive" : "neutral"}
                    />
                  </div>
                  <p>
                    {triggerLabels[item.trigger]} · {copy.priority}{" "}
                    {item.priority}
                  </p>
                  <small>
                    {item.agentName ?? copy.noAgent}
                    {item.agentVersion === null
                      ? ""
                      : ` v${String(item.agentVersion)}`}{" "}
                    → {item.flowName ?? copy.noFlow}
                    {item.flowVersion === null
                      ? ""
                      : ` v${String(item.flowVersion)}`}{" "}
                    · {item.businessObject ?? copy.noObject}
                  </small>
                </div>
                <Button
                  disabled={pending !== undefined}
                  onClick={() => void toggleProcess(item)}
                  type="button"
                  variant="secondary"
                >
                  {pending === `process:${item.id}`
                    ? copy.saving
                    : item.enabled
                      ? copy.disable
                      : copy.enable}
                </Button>
              </article>
            ))
          )}
        </div>
        <form
          className={styles.form}
          onSubmit={(event) => void createProcess(event)}
        >
          <h3>{copy.createProcess}</h3>
          <Input id="process-name" label={copy.name} name="name" required />
          <Input id="process-purpose" label={copy.purpose} name="purpose" />
          <Select
            id="process-trigger"
            label={copy.trigger}
            name="trigger"
            required
          >
            {Object.entries(triggerLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
          <Select id="process-channel" label={copy.channel} name="channel">
            <option value="">{copy.anyChannel}</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="voice">Voice</option>
            <option value="manual">{copy.manual}</option>
          </Select>
          <Select
            id="process-object"
            label={copy.businessObject}
            name="businessObject"
          >
            <option value="">{copy.none}</option>
            <option value="contact">Contact</option>
            <option value="lead">Lead</option>
            <option value="deal">Deal</option>
            <option value="ticket">Ticket</option>
            <option value="service_case">Service case</option>
            <option value="appointment">Appointment</option>
            <option value="document">Document</option>
          </Select>
          <Select
            id="process-agent"
            label={copy.publishedAgent}
            name="agentProfileVersionId"
          >
            <option value="">{copy.chooseAgent}</option>
            {options.agents.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} · {option.channels.join("/")}
              </option>
            ))}
          </Select>
          <Select
            id="process-flow"
            label={copy.publishedFlow}
            name="flowVersionId"
          >
            <option value="">{copy.chooseFlow}</option>
            {options.flows.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} · {option.channels.join("/")}
              </option>
            ))}
          </Select>
          <Input
            defaultValue="100"
            id="process-priority"
            label={copy.priorityLabel}
            min="0"
            max="10000"
            name="priority"
            type="number"
          />
          <Select
            defaultValue="false"
            id="process-enabled"
            label={copy.initialStatus}
            name="enabled"
          >
            <option value="false">{copy.draft}</option>
            <option value="true">{copy.active}</option>
          </Select>
          <Button disabled={pending !== undefined} type="submit">
            {pending === "process:new" ? copy.creating : copy.createProcess}
          </Button>
        </form>
      </Surface>
    </div>
  );
}
