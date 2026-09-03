"use client";

import { errorMessage } from "../../i18n/error-message";
import { activityLabel } from "../../i18n/activity-label";
import { useCapability } from "../access";
import { useTranslations, useLocale } from "next-intl";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import type {
  ContactActivity,
  ContactDetail,
  ContactCustomField,
  JsonValue,
} from "@or-on/crm";
import { Button, Input, Surface } from "@or-on/ui";

import { crmMutation } from "../crm";
import { voiceMutation } from "../voice";

function fieldText(
  value: ContactDetail["customFields"][number]["value"],
): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function fieldValue(
  fieldType: ContactCustomField["fieldType"],
  input: FormDataEntryValue | null,
): JsonValue {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) return null;
  if (fieldType === "number") {
    const number = Number(value);
    if (!Number.isFinite(number))
      throw new TypeError("invalid custom field value");
    return number;
  }
  if (fieldType === "boolean") {
    if (value !== "true" && value !== "false")
      throw new TypeError("invalid custom field value");
    return value === "true";
  }
  if (fieldType === "multi_select") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new TypeError("invalid custom field value");
    }
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item: unknown) => typeof item === "string")
    )
      throw new TypeError("invalid custom field value");
    return parsed;
  }
  return value;
}

export function ContactDetailPanel({
  activity,
  contact,
}: {
  readonly activity: readonly ContactActivity[];
  readonly contact: ContactDetail;
}) {
  const t = useTranslations();
  const canEdit = useCapability("crm:write");
  const locale = useLocale();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function mutate(operation: () => Promise<unknown>) {
    setPending(true);
    setError(undefined);
    try {
      await operation();
      router.refresh();
      return true;
    } catch (caught) {
      setError(errorMessage(caught, t, "contacts.updateFailed"));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function update(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await mutate(() =>
      crmMutation(
        `/api/crm/contacts/${contact.id}`,
        {
          name: data.get("name"),
          email: data.get("email"),
          company: data.get("company"),
        },
        { method: "PATCH" },
      ),
    );
  }

  async function addNote(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const saved = await mutate(() =>
      crmMutation(`/api/crm/contacts/${contact.id}/notes`, {
        body: data.get("body"),
      }),
    );
    if (saved) form.reset();
  }

  const callableIdentity = contact.identities.find(
    (identity) =>
      (identity.channel === "phone" || identity.channel === "whatsapp") &&
      identity.normalizedValue !== null &&
      identity.validationStatus !== "invalid",
  );

  return (
    <div className="detail-grid">
      <Surface level="raised">
        <h2>{t("contacts.profile")}</h2>
        <form className="feature-form" onSubmit={(event) => void update(event)}>
          <fieldset className="form-fieldset" disabled={pending || !canEdit}>
            {!canEdit ? (
              <p className="public-note">{t("common.readOnly")}</p>
            ) : null}
            <Input
              defaultValue={contact.name}
              id="detail-name"
              label={t("common.name")}
              name="name"
              required
            />
            <Input
              defaultValue={contact.email ?? ""}
              id="detail-email"
              label={t("common.email")}
              name="email"
              type="email"
            />
            <Input
              defaultValue={contact.company ?? ""}
              id="detail-company"
              label={t("common.company")}
              name="company"
            />
            <Button disabled={pending || !canEdit} type="submit">
              {t("contacts.saveProfile")}
            </Button>
          </fieldset>
        </form>
        <div className="feature-form">
          <label htmlFor="voice-consent">{t("contacts.voiceConsent")}</label>
          <select
            disabled={pending || !canEdit}
            id="voice-consent"
            onChange={(event) =>
              void mutate(() =>
                crmMutation(
                  `/api/crm/contacts/${contact.id}`,
                  { voiceConsent: event.target.value },
                  { method: "PATCH" },
                ),
              )
            }
            value={contact.voiceConsent}
          >
            <option value="unknown">{t("common.unknown")}</option>
            <option value="granted">{t("common.granted")}</option>
            <option value="revoked">{t("common.revoked")}</option>
          </select>
          <Button
            disabled={
              pending ||
              contact.voiceConsent !== "granted" ||
              callableIdentity === undefined
            }
            onClick={() =>
              void mutate(() =>
                voiceMutation("/api/voice/simulated-calls", {
                  contactId: contact.id,
                  idempotencyKey: `contact:${contact.id}:${String(Date.now())}`,
                }),
              )
            }
            type="button"
            variant="secondary"
          >
            {t("contacts.call")}
          </Button>
          <small>{t("contacts.callHint")}</small>
          <label htmlFor="whatsapp-consent">
            {t("contacts.whatsappConsent")}
          </label>
          <select
            disabled={pending || !canEdit}
            id="whatsapp-consent"
            onChange={(event) =>
              void mutate(() =>
                crmMutation(
                  `/api/crm/contacts/${contact.id}`,
                  { whatsAppConsent: event.target.value },
                  { method: "PATCH" },
                ),
              )
            }
            value={contact.whatsAppConsent}
          >
            <option value="unknown">{t("common.unknown")}</option>
            <option value="granted">{t("common.granted")}</option>
            <option value="revoked">{t("contacts.optedOut")}</option>
          </select>
          <small>{t("contacts.consentHint")}</small>
        </div>
        <div className="detail-identities">
          <h3>{t("contacts.identities")}</h3>
          {contact.identities.map((identity) => (
            <p key={identity.id}>
              {identity.channel}:{" "}
              {identity.displayValue ?? identity.normalizedValue}
            </p>
          ))}
        </div>
      </Surface>

      <Surface>
        <h2>{t("contacts.notes")}</h2>
        <form className="note-form" onSubmit={(event) => void addNote(event)}>
          <fieldset className="form-fieldset" disabled={pending || !canEdit}>
            {!canEdit ? (
              <p className="public-note">{t("common.readOnly")}</p>
            ) : null}
            <label htmlFor="contact-note">{t("contacts.noteLabel")}</label>
            <textarea id="contact-note" name="body" required rows={4} />
            <Button
              disabled={pending || !canEdit}
              type="submit"
              variant="secondary"
            >
              {t("contacts.addNote")}
            </Button>
          </fieldset>
        </form>
        <div className="note-list">
          {contact.notes.length === 0 ? (
            <p>{t("contacts.noNotes")}</p>
          ) : (
            contact.notes.map((note) => (
              <article key={note.id}>
                <p>{note.body}</p>
                <small>{new Date(note.createdAt).toLocaleString(locale)}</small>
              </article>
            ))
          )}
        </div>
      </Surface>

      <Surface>
        <h2>{t("contacts.fields")}</h2>
        {contact.customFields.length === 0 ? (
          <p>{t("contacts.noFields")}</p>
        ) : (
          contact.customFields.map((field) => (
            <form
              className="custom-field-row"
              key={field.id}
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void mutate(() =>
                  crmMutation(
                    `/api/crm/contacts/${contact.id}/custom-fields/${field.id}`,
                    { value: fieldValue(field.fieldType, data.get("value")) },
                  ),
                );
              }}
            >
              <fieldset
                className="form-fieldset"
                disabled={pending || !canEdit}
              >
                {!canEdit ? (
                  <p className="public-note">{t("common.readOnly")}</p>
                ) : null}
                {field.fieldType === "boolean" ? (
                  <label className="or-field">
                    <span>{field.label}</span>
                    <select name="value" defaultValue={fieldText(field.value)}>
                      <option value="">{t("common.notSet")}</option>
                      <option value="true">{t("contacts.true")}</option>
                      <option value="false">{t("contacts.false")}</option>
                    </select>
                  </label>
                ) : (
                  <Input
                    defaultValue={fieldText(field.value)}
                    id={`field-${field.id}`}
                    label={field.label}
                    name="value"
                    type={
                      field.fieldType === "number"
                        ? "number"
                        : field.fieldType === "date"
                          ? "date"
                          : "text"
                    }
                    step={field.fieldType === "number" ? "any" : undefined}
                    {...(field.fieldType === "multi_select"
                      ? { hint: t("contacts.multiSelectHint") }
                      : {})}
                  />
                )}
                <Button
                  disabled={pending || !canEdit}
                  type="submit"
                  variant="quiet"
                >
                  {t("common.save")}
                </Button>
              </fieldset>
            </form>
          ))
        )}
      </Surface>
      <Surface>
        <h2>{t("contacts.activity")}</h2>
        {activity.length === 0 ? (
          <p>{t("contacts.noActivity")}</p>
        ) : (
          <ol className="timeline">
            {activity.map((item) => (
              <li key={`${item.sourceType}-${item.eventId}`}>
                <div>
                  <strong>{activityLabel(item.eventType, t)}</strong>
                  <time>
                    {new Date(item.occurredAt).toLocaleString(locale)}
                  </time>
                </div>
                <details className="technical-details">
                  <summary>{t("contacts.technical")}</summary>
                  <code dir="ltr">{item.eventType}</code>
                  <pre>{JSON.stringify(item.metadata, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ol>
        )}
      </Surface>
      {error === undefined ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
