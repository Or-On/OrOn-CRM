"use client";

import { errorMessage } from "../../i18n/error-message";
import { activityLabel } from "../../i18n/activity-label";
import { tenantDateFormatter } from "../../i18n/tenant-date-time";
import { useCapability } from "../access";
import { useTranslations, useLocale } from "next-intl";

import {
  FileText,
  FolderOpen,
  MapPin,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  UploadCloud,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import type {
  ContactActivity,
  ContactDetail,
  ContactCustomField,
  CustomerClassification,
  CustomerDossier,
  JsonValue,
  ServiceCaseSummary,
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

import { crmMutation, crmRead, csrfToken } from "../crm";
import { ContactCallDialog } from "./contact-call-dialog";

async function uploadCustomerDocument(
  contactId: string,
  form: FormData,
  onProgress: (value: number) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/crm/contacts/${contactId}/documents`);
    request.setRequestHeader("x-csrf-token", csrfToken());
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      let payload: unknown;
      try {
        payload = JSON.parse(request.responseText) as unknown;
      } catch {
        reject(new Error("The upload returned an unreadable response"));
        return;
      }
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      reject(
        new Error(
          payload !== null &&
            typeof payload === "object" &&
            "error" in payload &&
            typeof payload.error === "string"
            ? payload.error
            : "Document upload failed",
        ),
      );
    });
    request.addEventListener("error", () =>
      reject(new Error("Document upload failed")),
    );
    request.send(form);
  });
}

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
  canManageClassifications = false,
  canReadSensitive = false,
  canWriteSensitive = false,
  classifications = [],
  contact,
  customerDossier,
  fieldServiceEnabled = false,
  realVoiceEnabled = false,
  serviceCases = [],
  timezone = "UTC",
  voiceAvailable = true,
  voiceFlows = [],
}: {
  readonly activity: readonly ContactActivity[];
  readonly canManageClassifications?: boolean;
  readonly canReadSensitive?: boolean;
  readonly canWriteSensitive?: boolean;
  readonly classifications?: readonly CustomerClassification[];
  readonly contact: ContactDetail;
  readonly customerDossier?: CustomerDossier;
  readonly fieldServiceEnabled?: boolean;
  readonly realVoiceEnabled?: boolean;
  readonly serviceCases?: readonly ServiceCaseSummary[];
  readonly timezone?: string;
  readonly voiceAvailable?: boolean;
  readonly voiceFlows?: readonly FlowSummary[];
}) {
  const t = useTranslations();
  const canEdit = useCapability("crm:write");
  const locale = useLocale();
  const date = tenantDateFormatter(locale, timezone, {
    dateStyle: "medium",
  });
  const dateTime = tenantDateFormatter(locale, timezone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [profileOpen, setProfileOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [classificationOpen, setClassificationOpen] = useState(false);
  const [editingClassification, setEditingClassification] =
    useState<CustomerClassification>();
  const [locationOpen, setLocationOpen] = useState(false);
  const [editingLocation, setEditingLocation] =
    useState<CustomerDossier["locations"][number]>();
  const [locationToArchive, setLocationToArchive] =
    useState<CustomerDossier["locations"][number]>();
  const [documentOpen, setDocumentOpen] = useState(false);
  const [documentToArchive, setDocumentToArchive] =
    useState<CustomerDossier["documents"][number]>();
  const [documentProgress, setDocumentProgress] = useState<number>();
  const [revealedNationalId, setRevealedNationalId] = useState<string>();
  const [clearNationalIdOpen, setClearNationalIdOpen] = useState(false);
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
  const dossier: CustomerDossier = customerDossier ?? {
    contactId: contact.id,
    nationalIdMasked: null,
    preferredLanguage: null,
    address: null,
    classifications: [],
    locations: [],
    documents: [],
  };

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

  async function updateCustomerFile(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await mutate(async () => {
      await crmMutation(
        `/api/crm/contacts/${contact.id}/dossier`,
        {
          preferredLanguage: data.get("preferredLanguage"),
          address: data.get("address"),
        },
        { method: "PATCH" },
      );
      const nationalIdValue = data.get("nationalId");
      const nationalId =
        typeof nationalIdValue === "string" ? nationalIdValue.trim() : "";
      if (canWriteSensitive && nationalId !== "") {
        await crmMutation(
          `/api/crm/contacts/${contact.id}/national-id`,
          { nationalId },
          { method: "PATCH" },
        );
        setRevealedNationalId(nationalId);
      }
    });
  }

  async function revealNationalId() {
    await mutate(async () => {
      const result = await crmRead<{ nationalId: string | null }>(
        `/api/crm/contacts/${contact.id}/national-id`,
      );
      setRevealedNationalId(result.nationalId ?? undefined);
    });
  }

  async function toggleClassification(
    classificationId: string,
    assigned: boolean,
  ) {
    await mutate(() =>
      crmMutation(
        `/api/crm/contacts/${contact.id}/classifications`,
        { classificationId, assigned },
        { method: "PATCH" },
      ),
    );
  }

  async function createClassification(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const saved = await mutate(() =>
      crmMutation(
        editingClassification === undefined
          ? "/api/crm/classifications"
          : `/api/crm/classifications/${editingClassification.id}`,
        {
          name: data.get("name"),
          description: data.get("description"),
          color: data.get("color"),
        },
        editingClassification === undefined ? {} : { method: "PATCH" },
      ),
    );
    if (saved) {
      form.reset();
      setClassificationOpen(false);
      setEditingClassification(undefined);
    }
  }

  async function saveLocation(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const coordinate = (key: string) => {
      const candidate = data.get(key);
      const value = typeof candidate === "string" ? candidate.trim() : "";
      return value === "" ? null : Number(value);
    };
    const saved = await mutate(() =>
      crmMutation(
        editingLocation === undefined
          ? `/api/crm/contacts/${contact.id}/locations`
          : `/api/crm/contacts/${contact.id}/locations/${editingLocation.id}`,
        {
          name: data.get("name"),
          address: data.get("address"),
          latitude: coordinate("latitude"),
          longitude: coordinate("longitude"),
          contactName: data.get("contactName"),
          contactPhone: data.get("contactPhone"),
          contactEmail: data.get("contactEmail"),
        },
        editingLocation === undefined ? {} : { method: "PATCH" },
      ),
    );
    if (saved) {
      form.reset();
      setLocationOpen(false);
      setEditingLocation(undefined);
    }
  }

  async function addCustomerDocument(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(undefined);
    setDocumentProgress(0);
    try {
      await uploadCustomerDocument(contact.id, data, setDocumentProgress);
      setDocumentOpen(false);
      form.reset();
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("contacts.documentUploadFailed"),
      );
    } finally {
      setPending(false);
      setDocumentProgress(undefined);
    }
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
                    {date.format(new Date(contact.createdAt))}
                  </time>
                </dd>
              </div>
              <div>
                <dt>{t("tenantPrimary.lastInteraction")}</dt>
                <dd>
                  {contact.lastActivityAt ? (
                    <time dateTime={contact.lastActivityAt}>
                      {date.format(new Date(contact.lastActivityAt))}
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
              {
                id: "customer-file",
                tabId: "contact-customer-file-tab",
                controls: "contact-customer-file-panel",
                label: t("contacts.customerFile"),
                count:
                  dossier.classifications.length +
                  dossier.locations.length +
                  dossier.documents.length +
                  serviceCases.length,
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
                        {dateTime.format(new Date(item.occurredAt))}
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
                      <time dateTime={note.createdAt}>
                        {dateTime.format(new Date(note.createdAt))}
                      </time>
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

          <Surface
            className="contact-record__customer-file contact-record__tab-panel"
            id="contact-customer-file-panel"
            role="tabpanel"
            aria-labelledby="contact-customer-file-tab"
            hidden={tab !== "customer-file"}
          >
            <header className="contact-record__section-heading">
              <div>
                <h2>{t("contacts.customerFile")}</h2>
                <p>{t("contacts.customerFileHint")}</p>
              </div>
            </header>
            <form
              className="customer-file-form"
              onSubmit={(event) => void updateCustomerFile(event)}
            >
              <fieldset
                className="form-fieldset"
                disabled={pending || !canEdit}
              >
                <div className="customer-file-grid">
                  <Input
                    defaultValue={dossier.address ?? ""}
                    id="customer-file-address"
                    label={t("contacts.customerAddress")}
                    maxLength={500}
                    name="address"
                  />
                  <Select
                    defaultValue={dossier.preferredLanguage ?? ""}
                    id="customer-file-language"
                    label={t("contacts.preferredLanguage")}
                    name="preferredLanguage"
                  >
                    <option value="">{t("common.notSet")}</option>
                    <option value="he">עברית</option>
                    <option value="en">English</option>
                  </Select>
                  <Input
                    autoComplete="off"
                    dir="ltr"
                    disabled={!canWriteSensitive || pending}
                    hint={
                      dossier.nationalIdMasked ??
                      t("contacts.nationalIdProtected")
                    }
                    id="customer-national-id"
                    label={t("contacts.nationalId")}
                    maxLength={40}
                    name="nationalId"
                    placeholder={t("contacts.nationalIdUnchanged")}
                  />
                  <div className="customer-file-sensitive-read">
                    <span>{t("contacts.protectedValue")}</span>
                    <strong dir="ltr">
                      {revealedNationalId ??
                        dossier.nationalIdMasked ??
                        t("common.notSet")}
                    </strong>
                    {canReadSensitive &&
                    dossier.nationalIdMasked !== null &&
                    revealedNationalId === undefined ? (
                      <Button
                        disabled={pending}
                        onClick={() => void revealNationalId()}
                        size="small"
                        type="button"
                        variant="quiet"
                      >
                        <ShieldCheck aria-hidden="true" size={14} />
                        {t("contacts.revealNationalId")}
                      </Button>
                    ) : null}
                    {canWriteSensitive &&
                    (dossier.nationalIdMasked !== null ||
                      revealedNationalId !== undefined) ? (
                      <Button
                        disabled={pending}
                        onClick={() => setClearNationalIdOpen(true)}
                        size="small"
                        type="button"
                        variant="danger"
                      >
                        <Trash2 aria-hidden="true" size={14} />
                        {t("contacts.clearNationalId")}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <Button disabled={pending || !canEdit} type="submit">
                  {t("contacts.saveCustomerFile")}
                </Button>
              </fieldset>
            </form>

            <section className="customer-file-section">
              <header>
                <div>
                  <h3>{t("contacts.classifications")}</h3>
                  <p>{t("contacts.classificationsHint")}</p>
                </div>
                {canManageClassifications ? (
                  <Button
                    onClick={() => {
                      setEditingClassification(undefined);
                      setClassificationOpen(true);
                    }}
                    size="small"
                    variant="secondary"
                  >
                    <Plus aria-hidden="true" size={14} />
                    {t("contacts.newClassification")}
                  </Button>
                ) : null}
              </header>
              {classifications.length === 0 ? (
                <p className="public-note">{t("contacts.noClassifications")}</p>
              ) : (
                <div className="customer-classification-list">
                  {classifications.map((classification) => {
                    const assigned = dossier.classifications.some(
                      (item) => item.id === classification.id,
                    );
                    return (
                      <div
                        className="customer-classification-item"
                        key={classification.id}
                      >
                        <label>
                          <input
                            checked={assigned}
                            disabled={pending || !canEdit}
                            onChange={(event) =>
                              void toggleClassification(
                                classification.id,
                                event.target.checked,
                              )
                            }
                            type="checkbox"
                          />
                          <span
                            aria-hidden="true"
                            className="customer-classification-swatch"
                            data-color={classification.color}
                          />
                          <span>
                            <strong>{classification.name}</strong>
                            {classification.description ? (
                              <small>{classification.description}</small>
                            ) : null}
                          </span>
                        </label>
                        {canManageClassifications ? (
                          <Button
                            aria-label={`${t("contacts.editClassification")}: ${classification.name}`}
                            onClick={() => {
                              setEditingClassification(classification);
                              setClassificationOpen(true);
                            }}
                            size="small"
                            title={t("contacts.editClassification")}
                            type="button"
                            variant="quiet"
                          >
                            <Pencil aria-hidden="true" size={14} />
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="customer-file-section">
              <header>
                <div>
                  <h3>{t("contacts.documents")}</h3>
                  <p>{t("contacts.documentsHint")}</p>
                </div>
                {canEdit ? (
                  <Button
                    onClick={() => setDocumentOpen(true)}
                    size="small"
                    variant="secondary"
                  >
                    <UploadCloud aria-hidden="true" size={14} />
                    {t("contacts.addDocument")}
                  </Button>
                ) : null}
              </header>
              {dossier.documents.length === 0 ? (
                <p className="public-note">{t("contacts.noDocuments")}</p>
              ) : (
                <div className="customer-document-list">
                  {dossier.documents.map((document) => (
                    <div
                      className="customer-document-list__item"
                      key={document.id}
                    >
                      <a
                        href={`/api/crm/contacts/${contact.id}/documents/${document.id}`}
                      >
                        <FileText aria-hidden="true" size={16} />
                        <span>
                          <strong dir="auto">{document.displayName}</strong>
                          <small>
                            {document.category} ·{" "}
                            {Math.max(1, Math.round(document.byteSize / 1024))}{" "}
                            KB
                          </small>
                        </span>
                        <Badge
                          label={document.status}
                          tone={
                            document.status === "available"
                              ? "positive"
                              : "neutral"
                          }
                        />
                      </a>
                      {canEdit &&
                      (document.category !== "identity" ||
                        canWriteSensitive) ? (
                        <Button
                          aria-label={`${t("common.delete")} ${document.displayName}`}
                          onClick={() => setDocumentToArchive(document)}
                          size="small"
                          type="button"
                          variant="quiet"
                        >
                          <Trash2 aria-hidden="true" size={14} />
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="customer-file-section">
              <header>
                <div>
                  <h3>{t("contacts.serviceLocations")}</h3>
                  <p>{t("contacts.serviceLocationsHint")}</p>
                </div>
                {canEdit ? (
                  <Button
                    onClick={() => setLocationOpen(true)}
                    size="small"
                    variant="secondary"
                  >
                    <MapPin aria-hidden="true" size={14} />
                    {t("contacts.addLocation")}
                  </Button>
                ) : null}
              </header>
              {dossier.locations.length === 0 ? (
                <p className="public-note">{t("contacts.noLocations")}</p>
              ) : (
                <div className="customer-location-grid">
                  {dossier.locations.map((location) => (
                    <article key={location.id}>
                      <MapPin aria-hidden="true" size={16} />
                      <div>
                        <strong>{location.name}</strong>
                        <span>{location.address ?? t("common.notSet")}</span>
                        {location.contactName || location.contactPhone ? (
                          <small>
                            {location.contactName ?? ""}
                            {location.contactPhone ? (
                              <bdi dir="ltr"> · {location.contactPhone}</bdi>
                            ) : null}
                          </small>
                        ) : null}
                        {location.latitude === null ? null : (
                          <small dir="ltr">
                            {location.latitude.toFixed(6)},{" "}
                            {location.longitude?.toFixed(6)}
                          </small>
                        )}
                      </div>
                      {canEdit ? (
                        <div className="customer-location-actions">
                          <Button
                            aria-label={`${t("common.rename")} ${location.name}`}
                            onClick={() => {
                              setEditingLocation(location);
                              setLocationOpen(true);
                            }}
                            size="small"
                            type="button"
                            variant="quiet"
                          >
                            <Pencil aria-hidden="true" size={14} />
                          </Button>
                          <Button
                            aria-label={`${t("common.delete")} ${location.name}`}
                            onClick={() => setLocationToArchive(location)}
                            size="small"
                            type="button"
                            variant="quiet"
                          >
                            <Trash2 aria-hidden="true" size={14} />
                          </Button>
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="customer-file-section">
              <header>
                <div>
                  <h3>{t("contacts.serviceHistory")}</h3>
                  <p>
                    {fieldServiceEnabled
                      ? t("contacts.serviceHistoryHint")
                      : t("contacts.serviceModuleDisabled")}
                  </p>
                </div>
              </header>
              {!fieldServiceEnabled || serviceCases.length === 0 ? (
                <p className="public-note">{t("contacts.noServiceCases")}</p>
              ) : (
                <div className="customer-service-cases">
                  {serviceCases.map((serviceCase) => (
                    <Link
                      href={`/field-service/cases/${serviceCase.id}`}
                      key={serviceCase.id}
                    >
                      <FolderOpen aria-hidden="true" size={16} />
                      <span>
                        <strong>{serviceCase.reference}</strong>
                        <small>{serviceCase.title}</small>
                      </span>
                      <Badge
                        label={serviceCase.status.replaceAll("_", " ")}
                        tone={
                          serviceCase.status === "completed" ||
                          serviceCase.status === "closed"
                            ? "positive"
                            : "neutral"
                        }
                      />
                    </Link>
                  ))}
                </div>
              )}
            </section>
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
      <Dialog
        closeLabel={t("common.close")}
        onClose={() => setDocumentOpen(false)}
        open={documentOpen}
        title={t("contacts.addDocument")}
      >
        {error && documentOpen ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <form
          className="feature-form"
          onSubmit={(event) => void addCustomerDocument(event)}
        >
          <fieldset className="form-fieldset" disabled={pending || !canEdit}>
            <Select
              defaultValue="general"
              id="customer-document-category"
              label={t("contacts.documentCategory")}
              name="category"
            >
              {[
                "general",
                "warranty",
                "invoice",
                "manual",
                ...(canWriteSensitive ? ["identity"] : []),
                "other",
              ].map((category) => (
                <option key={category} value={category}>
                  {t(`contacts.documentCategories.${category}`)}
                </option>
              ))}
            </Select>
            <Input
              id="customer-document-caption"
              label={t("contacts.documentCaption")}
              maxLength={1000}
              name="caption"
            />
            <label className="customer-document-picker">
              <UploadCloud aria-hidden="true" size={22} />
              <span>{t("contacts.chooseDocument")}</span>
              <input
                accept="image/jpeg,image/png,image/webp,application/pdf,text/plain"
                name="file"
                required
                type="file"
              />
            </label>
            {documentProgress === undefined ? null : (
              <progress max={100} value={documentProgress}>
                {documentProgress}%
              </progress>
            )}
            <div className="form-actions">
              <Button disabled={pending} type="submit">
                {pending
                  ? t("contacts.uploadingDocument")
                  : t("contacts.uploadDocument")}
              </Button>
            </div>
          </fieldset>
        </form>
      </Dialog>
      <ConfirmDialog
        busy={pending}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("contacts.clearNationalId")}
        description={t("contacts.clearNationalIdDescription")}
        destructive
        onCancel={() => setClearNationalIdOpen(false)}
        onConfirm={() => {
          void mutate(async () => {
            await crmMutation(
              `/api/crm/contacts/${contact.id}/national-id`,
              { nationalId: null },
              { method: "PATCH" },
            );
            setRevealedNationalId(undefined);
            setClearNationalIdOpen(false);
          });
        }}
        open={clearNationalIdOpen}
        title={t("contacts.clearNationalId")}
      />
      <ConfirmDialog
        busy={pending}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.delete")}
        description={
          documentToArchive === undefined
            ? ""
            : `${documentToArchive.displayName}. ${t("common.actionCannotBeUndone")}`
        }
        onCancel={() => setDocumentToArchive(undefined)}
        onConfirm={() => {
          if (documentToArchive === undefined) return;
          void mutate(async () => {
            await crmMutation(
              `/api/crm/contacts/${contact.id}/documents/${documentToArchive.id}`,
              {},
              { method: "DELETE" },
            );
            setDocumentToArchive(undefined);
          });
        }}
        open={documentToArchive !== undefined}
        destructive
        title={t("contacts.archiveDocument")}
      />
      <Dialog
        closeLabel={t("common.close")}
        onClose={() => {
          setClassificationOpen(false);
          setEditingClassification(undefined);
        }}
        open={classificationOpen}
        title={
          editingClassification === undefined
            ? t("contacts.newClassification")
            : t("contacts.editClassification")
        }
      >
        <form
          className="feature-form"
          key={editingClassification?.id ?? "new-classification"}
          onSubmit={(event) => void createClassification(event)}
        >
          <fieldset
            className="form-fieldset"
            disabled={pending || !canManageClassifications}
          >
            <Input
              data-dialog-initial-focus
              defaultValue={editingClassification?.name ?? ""}
              id="classification-name"
              label={t("common.name")}
              maxLength={80}
              name="name"
              required
            />
            <Input
              id="classification-description"
              defaultValue={editingClassification?.description ?? ""}
              label={t("contacts.classificationDescription")}
              maxLength={500}
              name="description"
            />
            <Select
              defaultValue={editingClassification?.color ?? "slate"}
              id="classification-color"
              label={t("contacts.classificationColor")}
              name="color"
            >
              {[
                "slate",
                "blue",
                "cyan",
                "emerald",
                "violet",
                "amber",
                "rose",
              ].map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </Select>
            <div className="form-actions">
              <Button disabled={pending} type="submit">
                {t("common.save")}
              </Button>
            </div>
          </fieldset>
        </form>
      </Dialog>
      <Dialog
        closeLabel={t("common.close")}
        onClose={() => {
          setLocationOpen(false);
          setEditingLocation(undefined);
        }}
        open={locationOpen}
        title={
          editingLocation === undefined
            ? t("contacts.addLocation")
            : t("contacts.editLocation")
        }
      >
        <form
          className="feature-form"
          key={editingLocation?.id ?? "new-location"}
          onSubmit={(event) => void saveLocation(event)}
        >
          <fieldset className="form-fieldset" disabled={pending || !canEdit}>
            <div className="form-grid">
              <Input
                data-dialog-initial-focus
                defaultValue={editingLocation?.name ?? ""}
                id="service-location-name"
                label={t("contacts.locationName")}
                maxLength={160}
                name="name"
                required
              />
              <Input
                id="service-location-address"
                defaultValue={editingLocation?.address ?? ""}
                label={t("contacts.customerAddress")}
                maxLength={500}
                name="address"
              />
              <Input
                id="service-location-contact"
                defaultValue={editingLocation?.contactName ?? ""}
                label={t("contacts.locationContact")}
                maxLength={160}
                name="contactName"
              />
              <Input
                dir="ltr"
                defaultValue={editingLocation?.contactPhone ?? ""}
                id="service-location-phone"
                label={t("contacts.locationPhone")}
                maxLength={40}
                name="contactPhone"
                type="tel"
              />
              <Input
                id="service-location-email"
                defaultValue={editingLocation?.contactEmail ?? ""}
                label={t("contacts.locationEmail")}
                maxLength={320}
                name="contactEmail"
                type="email"
              />
              <Input
                dir="ltr"
                defaultValue={editingLocation?.latitude ?? ""}
                id="service-location-latitude"
                label={t("contacts.latitude")}
                max="90"
                min="-90"
                name="latitude"
                step="any"
                type="number"
              />
              <Input
                dir="ltr"
                defaultValue={editingLocation?.longitude ?? ""}
                id="service-location-longitude"
                label={t("contacts.longitude")}
                max="180"
                min="-180"
                name="longitude"
                step="any"
                type="number"
              />
            </div>
            <div className="form-actions">
              <Button disabled={pending} type="submit">
                {t("common.save")}
              </Button>
            </div>
          </fieldset>
        </form>
      </Dialog>
      <ConfirmDialog
        busy={pending}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.delete")}
        description={
          locationToArchive === undefined
            ? ""
            : `${locationToArchive.name}. ${t("common.actionCannotBeUndone")}`
        }
        destructive
        onCancel={() => setLocationToArchive(undefined)}
        onConfirm={() => {
          if (locationToArchive === undefined) return;
          void mutate(async () => {
            await crmMutation(
              `/api/crm/contacts/${contact.id}/locations/${locationToArchive.id}`,
              {},
              { method: "DELETE" },
            );
            setLocationToArchive(undefined);
          });
        }}
        open={locationToArchive !== undefined}
        title={t("contacts.archiveLocation")}
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
