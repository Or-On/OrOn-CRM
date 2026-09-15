"use client";

import type { FieldServiceFeatureState } from "@or-on/crm";
import {
  Badge,
  Button,
  Checkbox,
  InlineFeedback,
  Select,
  StatusIndicator,
  Surface,
} from "@or-on/ui";
import {
  CalendarClock,
  MessageCircleMore,
  ScanText,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { useState, type SyntheticEvent } from "react";

import { crmMutation } from "../crm";

export interface FieldServiceRuntimeReadiness {
  readonly aiProviderConfigured: boolean;
  readonly protectedFieldsConfigured: boolean;
  readonly privateStorageConfigured: boolean;
  readonly storageBackend: string;
}

export function FieldServiceSettings({
  initialState,
  runtimeReadiness,
}: {
  readonly initialState: FieldServiceFeatureState;
  readonly runtimeReadiness?: FieldServiceRuntimeReadiness;
}) {
  const locale = useLocale();
  const he = locale.startsWith("he");
  const [feature, setFeature] = useState(initialState);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [critical, setCritical] = useState(false);
  const runtime = runtimeReadiness ?? {
    aiProviderConfigured: false,
    protectedFieldsConfigured: false,
    privateStorageConfigured: false,
    storageBackend: "unknown",
  };
  const missingRequirements = [
    ...(!runtime.privateStorageConfigured
      ? [
          he
            ? `מתאם אחסון ראיות פרטי (${runtime.storageBackend})`
            : `private evidence adapter (${runtime.storageBackend})`,
        ]
      : []),
    ...(feature.whatsAppIntakeEnabled && !runtime.aiProviderConfigured
      ? [he ? "ספק AI מובנה" : "structured AI provider"]
      : []),
    ...(feature.whatsAppIntakeEnabled && !runtime.protectedFieldsConfigured
      ? [he ? "מפתחות שדות מוגנים" : "protected-field keys"]
      : []),
    ...(feature.ocrEnabled && !runtime.aiProviderConfigured
      ? [he ? "ספק OCR/AI" : "OCR/AI provider"]
      : []),
  ];

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setMessage(undefined);
    try {
      const payload = await crmMutation<{ feature: FieldServiceFeatureState }>(
        "/api/settings/field-service",
        {
          enabled: form.get("enabled") === "on",
          whatsAppIntakeEnabled: form.get("whatsAppIntakeEnabled") === "on",
          aiSchedulingEnabled: form.get("aiSchedulingEnabled") === "on",
          ocrEnabled: form.get("ocrEnabled") === "on",
          sharedTechnicianLoginEnabled:
            form.get("sharedTechnicianLoginEnabled") === "on",
          aiScheduleRequiresApproval:
            form.get("aiScheduleRequiresApproval") === "on",
          calendarAccess: form.get("calendarAccess"),
          calendarProvider:
            form.get("calendarAccess") === "none" ? null : "crm_calendar",
        },
        { method: "PATCH" },
      );
      setFeature(payload.feature);
      setCritical(false);
      setMessage(
        he ? "הגדרות שירות השטח נשמרו." : "Field-service settings saved.",
      );
    } catch (error) {
      setCritical(true);
      setMessage(
        error instanceof Error
          ? error.message
          : he
            ? "לא ניתן לשמור את ההגדרות."
            : "The settings could not be saved.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Surface className="field-service-settings" level="raised">
      <div className="field-service-settings__heading">
        <span className="settings-list-icon">
          <Wrench aria-hidden="true" size={19} />
        </span>
        <div>
          <span className="eyebrow">
            {he ? "יכולת אופציונלית" : "Optional capability"}
          </span>
          <h3>{he ? "שירות שטח וטכנאים" : "Field service & technicians"}</h3>
          <p>
            {he
              ? "תיקים, תזמון, נוכחות, ראיות ודוחות—מבודדים לסביבת העבודה הזו."
              : "Cases, scheduling, attendance, evidence, and reports isolated to this workspace."}
          </p>
        </div>
        <Badge
          label={
            feature.effective
              ? he
                ? "פעיל"
                : "Active"
              : feature.available
                ? he
                  ? "זמין · כבוי"
                  : "Available · off"
                : he
                  ? "לא נכלל"
                  : "Not entitled"
          }
          tone={feature.effective ? "positive" : "neutral"}
        />
      </div>

      {!feature.available ? (
        <>
          <InlineFeedback
            description={
              he
                ? "מנהל פלטפורמה צריך להוסיף את היכולת לדייר לפני שניתן להפעיל אותה."
                : "A platform administrator must grant this capability before it can be activated."
            }
          />
          <div className="field-service-settings__archive-links">
            <Link
              className="text-link"
              href="/api/settings/field-service/archive"
            >
              {he ? "אינדקס ארכיון CSV" : "CSV archive index"}
            </Link>
            <Link
              className="text-link"
              href="/api/settings/field-service/archive?format=json"
            >
              {he ? "אינדקס תיקים JSON" : "JSON dossier index"}
            </Link>
          </div>
        </>
      ) : (
        <form
          className="field-service-settings__form"
          onSubmit={(event) => void save(event)}
        >
          <Checkbox defaultChecked={feature.enabled} name="enabled">
            <span>
              <strong>{he ? "הפעלת המודול" : "Enable module"}</strong>
              <small>
                {he
                  ? "כיבוי עוצר פעולות חדשות ושומר את ההיסטוריה לקריאה ויצוא מורשים."
                  : "Turning it off blocks new work while preserving authorized archive and export access."}
              </small>
            </span>
          </Checkbox>
          <div className="field-service-settings__options">
            <Checkbox
              defaultChecked={feature.whatsAppIntakeEnabled}
              name="whatsAppIntakeEnabled"
            >
              <MessageCircleMore aria-hidden="true" size={17} />
              {he ? "קליטה מובנית מ-WhatsApp" : "Structured WhatsApp intake"}
            </Checkbox>
            <Checkbox
              defaultChecked={feature.aiSchedulingEnabled}
              name="aiSchedulingEnabled"
            >
              <CalendarClock aria-hidden="true" size={17} />
              {he ? "הצעות תזמון באמצעות AI" : "AI scheduling suggestions"}
            </Checkbox>
            <Checkbox
              defaultChecked={feature.aiScheduleRequiresApproval}
              name="aiScheduleRequiresApproval"
            >
              <ShieldCheck aria-hidden="true" size={17} />
              {he
                ? "דרוש אישור אנושי להצעת AI"
                : "Require human approval for AI suggestions"}
            </Checkbox>
            <Checkbox defaultChecked={feature.ocrEnabled} name="ocrEnabled">
              <ScanText aria-hidden="true" size={17} />
              {he ? "עיבוד OCR אופציונלי" : "Optional OCR processing"}
            </Checkbox>
            <Checkbox
              defaultChecked={feature.sharedTechnicianLoginEnabled}
              name="sharedTechnicianLoginEnabled"
            >
              <Wrench aria-hidden="true" size={17} />
              {he
                ? "כניסת טכנאים משותפת לדייר"
                : "Tenant-scoped shared technician login"}
            </Checkbox>
          </div>
          <div className="field-service-settings__calendar">
            <Select
              defaultValue={feature.calendarAccess}
              id="field-service-calendar-access"
              label={he ? "הרשאת יומן לתזמון" : "Scheduling calendar access"}
              name="calendarAccess"
            >
              <option value="none">
                {he
                  ? "ללא גישה · תזמון ידני בלבד"
                  : "No access · manual scheduling only"}
              </option>
              <option value="read_only">
                {he
                  ? "קריאה בלבד · הצעות בלבד"
                  : "Read only · suggestions only"}
              </option>
              <option value="write">
                {he
                  ? "קריאה וכתיבה · יומן הדייר"
                  : "Read and write · tenant calendar"}
              </option>
            </Select>
            <p>
              {he
                ? "חיבור היומן המובנה הוא החיבור היחיד הנתמך כרגע. קריאה בלבד לעולם אינה יוצרת אירוע."
                : "The built-in tenant calendar is the only supported connection. Read-only access never creates an event."}
            </p>
          </div>
          <div
            className="field-service-readiness"
            aria-label={he ? "מוכנות חיבורים" : "Integration readiness"}
          >
            <StatusIndicator
              label={he ? "תזמון ידני מוכן" : "Manual scheduling ready"}
              tone="positive"
            />
            <StatusIndicator
              label={he ? "ערוץ WhatsApp" : "WhatsApp channel"}
              tone={feature.readiness.whatsAppChannel ? "positive" : "warning"}
            />
            <StatusIndicator
              label={he ? "סוכן WhatsApp" : "WhatsApp agent"}
              tone={feature.readiness.whatsAppAgent ? "positive" : "warning"}
            />
            <StatusIndicator
              label={he ? "ספק AI ו-OCR" : "AI & OCR provider"}
              tone={runtime.aiProviderConfigured ? "positive" : "warning"}
            />
            <StatusIndicator
              label={he ? "שדות רגישים מוגנים" : "Protected sensitive fields"}
              tone={runtime.protectedFieldsConfigured ? "positive" : "warning"}
            />
            <StatusIndicator
              label={
                he
                  ? `אחסון ראיות פרטי · ${runtime.storageBackend}`
                  : `Private evidence storage · ${runtime.storageBackend}`
              }
              tone={runtime.privateStorageConfigured ? "positive" : "warning"}
            />
            <StatusIndicator
              label={
                feature.readiness.calendarCanBook
                  ? he
                    ? "יומן מוכן להזמנה"
                    : "Calendar ready to book"
                  : feature.readiness.calendarCanSuggest
                    ? he
                      ? "יומן לקריאה · הצעות בלבד"
                      : "Read-only calendar · suggestions only"
                    : he
                      ? "יומן לא מחובר"
                      : "Calendar not connected"
              }
              tone={
                feature.readiness.calendarCanBook
                  ? "positive"
                  : feature.readiness.calendarCanSuggest
                    ? "warning"
                    : "neutral"
              }
            />
          </div>
          {missingRequirements.length === 0 ? null : (
            <InlineFeedback
              description={`${
                he ? "דרישות חסרות" : "Missing requirements"
              }: ${missingRequirements.join(", ")}.`}
              tone="warning"
            />
          )}
          {message ? (
            <InlineFeedback
              description={message}
              tone={critical ? "critical" : "positive"}
            />
          ) : null}
          <div className="field-service-settings__actions">
            <p>
              {feature.changedAt
                ? `${he ? "עודכן" : "Last changed"}: ${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(feature.changedAt))}${feature.changedByDisplayName ? ` · ${feature.changedByDisplayName}` : ""}`
                : he
                  ? "טרם שונה"
                  : "Not changed yet"}
            </p>
            <Button disabled={pending} type="submit">
              {pending
                ? he
                  ? "שומר…"
                  : "Saving…"
                : he
                  ? "שמירת הגדרות"
                  : "Save settings"}
            </Button>
            <span className="field-service-settings__archive-links">
              <Link
                className="text-link"
                href="/api/settings/field-service/archive"
              >
                {he ? "אינדקס CSV" : "CSV index"}
              </Link>
              <Link
                className="text-link"
                href="/api/settings/field-service/archive?format=json"
              >
                {he ? "אינדקס JSON" : "JSON index"}
              </Link>
            </span>
          </div>
        </form>
      )}
    </Surface>
  );
}
