"use client";

import { errorMessage } from "../../i18n/error-message";
import { activityLabel } from "../../i18n/activity-label";
import { useCapability } from "../access";
import { useTranslations, useLocale } from "next-intl";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import type {
  ContactActivity,
  ContactDetail,
  ContactCustomField,
  JsonValue,
} from "@or-on/crm";
import type { FlowSummary } from "@or-on/api-client";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  Input,
  Select,
  Surface,
  Tabs,
} from "@or-on/ui";

import { crmMutation } from "../crm";
import { ContactCallDialog } from "./contact-call-dialog";

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
  realVoiceEnabled = false,
  voiceAvailable = true,
  voiceFlows = [],
}: {
  readonly activity: readonly ContactActivity[];
  readonly contact: ContactDetail;
  readonly realVoiceEnabled?: boolean;
  readonly voiceAvailable?: boolean;
  readonly voiceFlows?: readonly FlowSummary[];
}) {
  const t = useTranslations();
  const canEdit = useCapability("crm:write");
  const locale = useLocale();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [profileOpen, setProfileOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [tab, setTab] = useState("activity");
  const [activityFilter, setActivityFilter] = useState("all");
  const visibleActivity = activity.filter(
    (item) =>
      activityFilter === "all" ||
      (activityFilter === "messaging"
        ? /message|messaging/.test(item.sourceType)
        : activityFilter === "voice"
          ? /voice|call/.test(item.sourceType)
          : /automation|agent|flow/.test(item.sourceType)),
  );
  const primaryIdentity =
    contact.identities.find((item) => item.isPrimary) ?? contact.identities[0];

  async function mutate(
    operation: () => Promise<unknown>,
    fallback = "contacts.updateFailed",
  ) {
    setPending(true);
    setError(undefined);
    try {
      await operation();
      router.refresh();
      return true;
    } catch (caught) {
      setError(errorMessage(caught, t, fallback));
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
          voiceConsent: data.get("voiceConsent"),
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

  async function removeContact() {
    if (!canEdit || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await crmMutation(
        `/api/crm/contacts/${contact.id}`,
        {},
        { method: "DELETE" },
      );
      setRemoveOpen(false);
      router.push("/contacts");
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught, t, "contacts.removeFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="contact-record">
      <header className="contact-record__header">
        <span className="contact-record__avatar" aria-hidden="true">
          {contact.name.trim().slice(0, 1)}
        </span>
        <div className="contact-record__identity">
          <p>{t("tenantPrimary.profile")}</p>
          <h2>
            <bdi>{contact.name}</bdi>
          </h2>
          <span>
            <bdi>
              {primaryIdentity?.displayValue ??
                primaryIdentity?.normalizedValue ??
                contact.email ??
                t("common.notSet")}
            </bdi>
          </span>
        </div>
        <div className="contact-record__header-actions">
          <Badge
            label={t(`status.${contact.lifecycleStatus}`)}
            tone={
              contact.lifecycleStatus === "blocked" ? "critical" : "neutral"
            }
          />
          <div className="contact-record__actions">
            <Button
              disabled={!canEdit}
              onClick={() => setProfileOpen(true)}
              variant="secondary"
            >
              {t("premiumPrimary.profileEdit")}
            </Button>
            <Button
              disabled={!voiceAvailable}
              onClick={() => setPermissionsOpen(true)}
            >
              {t("tenantPrimary.call")}
            </Button>
            {canEdit ? (
              <Button
                disabled={pending}
                onClick={() => {
                  setError(undefined);
                  setRemoveOpen(true);
                }}
                variant="danger"
              >
                <Trash2 aria-hidden="true" size={16} />
                {t("contacts.remove")}
              </Button>
            ) : null}
          </div>
        </div>
      </header>
      {!voiceAvailable ? (
        <p className="public-note" role="status">
          {t("contacts.voiceServiceUnavailable")}
        </p>
      ) : null}
      {error === undefined ||
      profileOpen ||
      permissionsOpen ||
      removeOpen ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="detail-grid">
        <aside
          className="contact-record__rail contact-record__sidebar"
          aria-label={t("contacts.profile")}
        >
          <Surface className="contact-record__profile" level="raised">
            <h2>{t("premiumPrimary.profileFacts")}</h2>
            <dl className="contact-record__facts">
              <div>
                <dt>{t("common.email")}</dt>
                <dd>
                  <bdi>{contact.email ?? t("common.notSet")}</bdi>
                </dd>
              </div>
              <div>
                <dt>{t("common.company")}</dt>
                <dd>
                  <bdi>{contact.company ?? t("common.notSet")}</bdi>
                </dd>
              </div>
              <div>
                <dt>{t("premiumPrimary.profileSince")}</dt>
                <dd>
                  <time dateTime={contact.createdAt}>
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                    }).format(new Date(contact.createdAt))}
                  </time>
                </dd>
              </div>
              <div>
                <dt>{t("tenantPrimary.lastInteraction")}</dt>
                <dd>
                  {contact.lastActivityAt ? (
                    <time dateTime={contact.lastActivityAt}>
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                      }).format(new Date(contact.lastActivityAt))}
                    </time>
                  ) : (
                    t("tenantPrimary.noInteraction")
                  )}
                </dd>
              </div>
            </dl>
            <div className="contact-record__channels">
              <h3>{t("contacts.identities")}</h3>
              {contact.identities.length ? (
                contact.identities.map((identity) => (
                  <div key={identity.id}>
                    <span>{identity.channel}</span>
                    <bdi>
                      {identity.displayValue ?? identity.normalizedValue}
                    </bdi>
                  </div>
                ))
              ) : (
                <p>{t("common.notSet")}</p>
              )}
            </div>
          </Surface>
          {contact.tags.length ? (
            <div className="contact-record__tags">
              {contact.tags.map((tag) => (
                <span key={tag.id}>
                  <bdi>{tag.name}</bdi>
                </span>
              ))}
            </div>
          ) : null}
          <Dialog
            className="contact-record__edit-dialog"
            closeLabel={t("common.close")}
            open={profileOpen}
            onClose={() => setProfileOpen(false)}
            title={t("premiumPrimary.profileEdit")}
            description={t("contacts.profileHint")}
          >
            {error && profileOpen ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <form
              className="feature-form"
              onSubmit={(event) => void update(event)}
            >
              <fieldset
                className="form-fieldset"
                disabled={pending || !canEdit}
              >
                {!canEdit ? (
                  <p className="public-note">{t("common.readOnly")}</p>
                ) : null}
                <Input
                  data-dialog-initial-focus
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
                <Select
                  defaultValue={contact.voiceConsent}
                  hint={t("contacts.voiceConsentHint")}
                  id="detail-voice-consent"
                  label={t("contacts.voiceConsent")}
                  name="voiceConsent"
                >
                  <option value="unknown">{t("common.unknown")}</option>
                  <option value="granted">{t("common.granted")}</option>
                  <option value="revoked">{t("common.revoked")}</option>
                </Select>
                <Button disabled={pending || !canEdit} type="submit">
                  {t("contacts.saveProfile")}
                </Button>
              </fieldset>
            </form>
          </Dialog>
        </aside>

        <div className="contact-record__rail contact-record__main">
          <Tabs
            activeId={tab}
            ariaLabel={t("tenantPrimary.profile")}
            direction={locale === "he" ? "rtl" : "ltr"}
            onChange={setTab}
            items={[
              {
                id: "activity",
                tabId: "contact-activity-tab",
                controls: "contact-activity-panel",
                label: t("tenantPrimary.activity"),
                count: activity.length,
              },
              {
                id: "notes",
                tabId: "contact-notes-tab",
                controls: "contact-notes-panel",
                label: t("contacts.notes"),
                count: contact.notes.length,
              },
              {
                id: "fields",
                tabId: "contact-fields-tab",
                controls: "contact-fields-panel",
                label: t("contacts.fields"),
                count: contact.customFields.length,
              },
            ]}
          />
          <Surface
            className="contact-record__activity contact-record__tab-panel"
            id="contact-activity-panel"
            role="tabpanel"
            aria-labelledby="contact-activity-tab"
            hidden={tab !== "activity"}
          >
            <header className="contact-record__section-heading">
              <div>
                <h2>{t("contacts.activity")}</h2>
                <p>
                  {t("tenantPrimary.activityScope", {
                    count: activity.length,
                  })}
                </p>
              </div>
            </header>
            <div
              className="contact-activity-filters"
              role="group"
              aria-label={t("tenantPrimary.activity")}
            >
              {["all", "messaging", "voice", "automation"].map((value) => (
                <Button
                  key={value}
                  size="small"
                  variant={activityFilter === value ? "secondary" : "quiet"}
                  aria-pressed={activityFilter === value}
                  onClick={() => setActivityFilter(value)}
                >
                  {t(
                    value === "all"
                      ? "tenantPrimary.allActivity"
                      : `tenantPrimary.${value}`,
                  )}
                </Button>
              ))}
            </div>
            {visibleActivity.length === 0 ? (
              <p>
                {activity.length === 0
                  ? t("contacts.noActivity")
                  : t("tenantPrimary.timelineEmpty")}
              </p>
            ) : (
              <ol className="timeline">
                {visibleActivity.map((item) => (
                  <li key={`${item.sourceType}-${item.eventId}`}>
                    <div>
                      <strong>{activityLabel(item.eventType, t)}</strong>
                      <time dateTime={item.occurredAt}>
                        {new Date(item.occurredAt).toLocaleString(locale)}
                      </time>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Surface>

          <Surface
            className="contact-record__notes contact-record__tab-panel"
            id="contact-notes-panel"
            role="tabpanel"
            aria-labelledby="contact-notes-tab"
            hidden={tab !== "notes"}
          >
            <h2>{t("contacts.notes")}</h2>
            <form
              className="note-form"
              onSubmit={(event) => void addNote(event)}
            >
              <fieldset
                className="form-fieldset"
                disabled={pending || !canEdit}
              >
                {!canEdit ? (
                  <p className="public-note">{t("common.readOnly")}</p>
                ) : null}
                <label htmlFor="contact-note">{t("contacts.noteLabel")}</label>
                <textarea
                  dir="auto"
                  id="contact-note"
                  name="body"
                  required
                  rows={4}
                />
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
                    <p dir="auto">{note.body}</p>
                    <small>
                      {new Date(note.createdAt).toLocaleString(locale)}
                    </small>
                  </article>
                ))
              )}
            </div>
          </Surface>

          <Surface
            className="contact-record__fields contact-record__tab-panel"
            id="contact-fields-panel"
            role="tabpanel"
            aria-labelledby="contact-fields-tab"
            hidden={tab !== "fields"}
          >
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
                        {
                          value: fieldValue(field.fieldType, data.get("value")),
                        },
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
                      <Select
                        id={`field-${field.id}`}
                        label={field.label}
                        name="value"
                        defaultValue={fieldText(field.value)}
                      >
                        <option value="">{t("common.notSet")}</option>
                        <option value="true">{t("contacts.true")}</option>
                        <option value="false">{t("contacts.false")}</option>
                      </Select>
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
        </div>
      </div>
      <ContactCallDialog
        contact={contact}
        enabled={realVoiceEnabled && voiceAvailable}
        flows={voiceFlows}
        open={permissionsOpen}
        onClose={() => setPermissionsOpen(false)}
      />
      <ConfirmDialog
        busy={pending}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("contacts.removeConfirm")}
        destructive
        description={t("contacts.removeDescription", {
          contact: contact.name,
        })}
        onCancel={() => {
          if (!pending) {
            setRemoveOpen(false);
            setError(undefined);
          }
        }}
        onConfirm={() => void removeContact()}
        open={removeOpen}
        title={t("contacts.removeTitle")}
      >
        {error && removeOpen ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
