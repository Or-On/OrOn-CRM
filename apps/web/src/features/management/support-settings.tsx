"use client";

import type {
  IdentityVerificationPolicy,
  TenantSettings,
  TenantSupportProfile,
  TenantTerminologyEntry,
} from "@or-on/crm";
import {
  tenantSupportTextLimits,
  validateTenantSupportText,
} from "@or-on/crm/support-profile-text";
import {
  Button,
  Checkbox,
  InlineFeedback,
  Input,
  SectionHeader,
  Select,
  Surface,
  Textarea,
} from "@or-on/ui";
import { Building2, Languages, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import { errorMessage } from "../../i18n/error-message";
import { crmMutation } from "../crm";

const factors = ["fullName", "phone", "nationalId", "customerNumber"] as const;

const weekdays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
type Weekday = (typeof weekdays)[number];

interface BusinessDay {
  readonly closed: boolean;
  readonly opensAt: string;
  readonly closesAt: string;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function businessDay(profile: TenantSupportProfile, day: Weekday): BusinessDay {
  const configured = record(profile.businessHours?.[day]);
  const configuredDay = Object.keys(configured).length > 0;
  return {
    closed:
      configured.closed === true ||
      (!configuredDay && (day === "friday" || day === "saturday")),
    opensAt: text(configured.opensAt, "09:00"),
    closesAt: text(configured.closesAt, "17:00"),
  };
}

function lines(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function optional(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned === "" ? undefined : cleaned;
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function listText(values: readonly string[] | undefined): string {
  return values?.join("\n") ?? "";
}

function emptyTerm(): TenantTerminologyEntry {
  return { term: "" };
}

export function TenantSupportSettings({
  settings,
  tenantName,
}: {
  readonly settings: TenantSettings;
  readonly tenantName: string;
}) {
  const t = useTranslations("tenantSupportSettings");
  const translate = useTranslations();
  const router = useRouter();
  const profile = settings.supportProfile ?? { schemaVersion: "1.0" };
  const policy = settings.identityVerification ?? {
    schemaVersion: "1.0",
    enabled: true,
    requiredFactors: ["fullName", "phone", "nationalId"],
    maxAttempts: 3,
    onFailure: "human_handoff",
    contextDisclosure: "after_verification",
  };
  const [terminology, setTerminology] = useState<
    readonly TenantTerminologyEntry[]
  >(profile.terminology?.length ? profile.terminology : [emptyTerm()]);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{
    readonly message: string;
    readonly tone: "critical" | "positive";
  }>();

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFeedback(undefined);
    try {
      const requiredFactors = factors.filter(
        (factor) => form.get(`factor-${factor}`) === "on",
      );
      const businessHours = {
        ...(profile.businessHours ?? {}),
        ...Object.fromEntries(
          weekdays.map((day) => {
            const closed = form.get(`hours-${day}-open`) !== "on";
            return [
              day,
              closed
                ? { closed: true }
                : {
                    closed: false,
                    opensAt: formText(form, `hours-${day}-start`),
                    closesAt: formText(form, `hours-${day}-end`),
                  },
            ];
          }),
        ),
      };
      const legalName = optional(form.get("legalName"));
      const businessDescription = optional(form.get("businessDescription"));
      const supportProfile: TenantSupportProfile = {
        schemaVersion: "1.0",
        displayName: formText(form, "displayName"),
        supportDisplayName: formText(form, "supportDisplayName"),
        ...(legalName === undefined ? {} : { legalName }),
        ...(businessDescription === undefined ? {} : { businessDescription }),
        productsAndServices: lines(form.get("productsAndServices")),
        authorizedAffiliations: lines(form.get("authorizedAffiliations")),
        primaryLanguage: formText(form, "primaryLanguage"),
        supportedLanguages: lines(form.get("supportedLanguages")),
        timezone: settings.timezone,
        businessHours,
        terminology: terminology
          .map((entry) => ({
            term: entry.term.trim(),
            ...(entry.preferredTerm?.trim()
              ? { preferredTerm: entry.preferredTerm.trim() }
              : {}),
            ...(entry.pronunciation?.trim()
              ? { pronunciation: entry.pronunciation.trim() }
              : {}),
            ...(entry.language?.trim()
              ? { language: entry.language.trim() }
              : {}),
          }))
          .filter((entry) => entry.term !== ""),
      };
      const identityVerification: IdentityVerificationPolicy = {
        schemaVersion: "1.0",
        enabled: form.get("verificationEnabled") === "on",
        requiredFactors,
        maxAttempts: Number(form.get("maxAttempts")),
        onFailure: formText(form, "onFailure") as "human_handoff" | "end_call",
        contextDisclosure: "after_verification",
      };
      validateTenantSupportText(supportProfile);
      await crmMutation(
        "/api/settings",
        {
          tenantName,
          displayName: settings.displayName,
          defaultCurrency: settings.defaultCurrency,
          locale: settings.locale,
          timezone: settings.timezone,
          businessName: settings.businessName,
          businessEmail: settings.businessEmail,
          businessPhone: settings.businessPhone,
          businessAddress: settings.businessAddress,
          accentToken: settings.accentToken,
          reportHeader: settings.reportHeader,
          reportFooter: settings.reportFooter,
          supportProfile,
          identityVerification,
        },
        { method: "PATCH" },
      );
      setFeedback({ message: t("saved"), tone: "positive" });
      router.refresh();
    } catch (reason) {
      setFeedback({
        message: errorMessage(reason, translate, "management.failed"),
        tone: "critical",
      });
    } finally {
      setPending(false);
    }
  }

  function updateTerm(
    index: number,
    key: keyof TenantTerminologyEntry,
    value: string,
  ) {
    setTerminology((entries) =>
      entries.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, [key]: value } : entry,
      ),
    );
  }

  return (
    <>
      <header className="settings-section-title">
        <h2>{t("title")}</h2>
        <p>{t("scope")}</p>
      </header>
      {feedback ? (
        <InlineFeedback description={feedback.message} tone={feedback.tone} />
      ) : null}
      <Surface className="settings-form-surface" level="raised">
        <SectionHeader description={t("hint")} title={t("configuration")} />
        <form className="feature-form" onSubmit={(event) => void save(event)}>
          <fieldset className="form-fieldset" disabled={pending}>
            <section
              aria-labelledby="support-identity-heading"
              className="settings-form-section"
            >
              <h3 id="support-identity-heading">
                <Building2 aria-hidden="true" size={16} />
                {t("identity")}
              </h3>
              <div className="settings-support-stack">
                <div className="settings-form-grid">
                  <Input
                    defaultValue={profile.displayName ?? tenantName}
                    id="support-display-name-public"
                    label={t("displayName")}
                    maxLength={160}
                    name="displayName"
                    required
                  />
                  <Input
                    defaultValue={
                      profile.supportDisplayName ??
                      settings.businessName ??
                      settings.displayName ??
                      tenantName
                    }
                    id="support-agent-name"
                    label={t("supportDisplayName")}
                    maxLength={160}
                    name="supportDisplayName"
                    required
                  />
                  <Input
                    defaultValue={profile.legalName ?? ""}
                    id="support-legal-name"
                    label={t("legalName")}
                    maxLength={240}
                    name="legalName"
                  />
                  <Input
                    defaultValue={profile.primaryLanguage ?? settings.locale}
                    id="support-primary-language"
                    label={t("primaryLanguage")}
                    maxLength={35}
                    name="primaryLanguage"
                    required
                  />
                </div>
                <Textarea
                  defaultValue={profile.businessDescription ?? ""}
                  id="support-business-description"
                  label={t("businessDescription")}
                  hint={t("businessDescriptionHint", {
                    maximum: tenantSupportTextLimits.businessDescription,
                  })}
                  name="businessDescription"
                  rows={4}
                />
                <div className="settings-form-grid">
                  <Textarea
                    defaultValue={listText(profile.productsAndServices)}
                    id="support-products"
                    label={t("productsAndServices")}
                    hint={t("productsAndServicesHint", {
                      maximumItems: tenantSupportTextLimits.productsAndServices,
                      maximumLength: tenantSupportTextLimits.productOrService,
                    })}
                    name="productsAndServices"
                    rows={5}
                  />
                  <Textarea
                    defaultValue={listText(profile.authorizedAffiliations)}
                    id="support-affiliations"
                    label={t("authorizedAffiliations")}
                    name="authorizedAffiliations"
                    rows={5}
                  />
                </div>
                <Textarea
                  defaultValue={listText(
                    profile.supportedLanguages ?? [settings.locale],
                  )}
                  id="support-languages"
                  label={t("supportedLanguages")}
                  name="supportedLanguages"
                  required
                  rows={3}
                />
              </div>
            </section>

            <section
              aria-labelledby="support-hours-heading"
              className="settings-form-section"
            >
              <h3 id="support-hours-heading">{t("businessHours")}</h3>
              <div className="settings-business-hours">
                {weekdays.map((day) => {
                  const configured = businessDay(profile, day);
                  return (
                    <div className="settings-business-hours__row" key={day}>
                      <Checkbox
                        defaultChecked={!configured.closed}
                        name={`hours-${day}-open`}
                      >
                        {t(`days.${day}`)}
                      </Checkbox>
                      <Input
                        defaultValue={configured.opensAt}
                        id={`hours-${day}-start`}
                        label={t("opensAt")}
                        name={`hours-${day}-start`}
                        type="time"
                      />
                      <Input
                        defaultValue={configured.closesAt}
                        id={`hours-${day}-end`}
                        label={t("closesAt")}
                        name={`hours-${day}-end`}
                        type="time"
                      />
                    </div>
                  );
                })}
              </div>
            </section>

            <section
              aria-labelledby="support-terminology-heading"
              className="settings-form-section"
            >
              <h3 id="support-terminology-heading">
                <Languages aria-hidden="true" size={16} />
                {t("terminology")}
              </h3>
              <div className="settings-support-stack">
                <p className="public-note">{t("terminologyHint")}</p>
                <div className="settings-terminology-list">
                  {terminology.map((entry, index) => (
                    <div className="settings-terminology-row" key={index}>
                      <Input
                        aria-label={t("term")}
                        id={`terminology-term-${String(index)}`}
                        label={t("term")}
                        maxLength={80}
                        onChange={(event) =>
                          updateTerm(index, "term", event.target.value)
                        }
                        value={entry.term}
                      />
                      <Input
                        id={`terminology-preferred-${String(index)}`}
                        label={t("preferredTerm")}
                        maxLength={80}
                        onChange={(event) =>
                          updateTerm(index, "preferredTerm", event.target.value)
                        }
                        value={entry.preferredTerm ?? ""}
                      />
                      <Input
                        id={`terminology-pronunciation-${String(index)}`}
                        label={t("pronunciation")}
                        maxLength={80}
                        onChange={(event) =>
                          updateTerm(index, "pronunciation", event.target.value)
                        }
                        value={entry.pronunciation ?? ""}
                      />
                      <Input
                        id={`terminology-language-${String(index)}`}
                        label={t("language")}
                        maxLength={35}
                        onChange={(event) =>
                          updateTerm(index, "language", event.target.value)
                        }
                        value={entry.language ?? ""}
                      />
                      <Button
                        aria-label={t("removeTerm")}
                        disabled={terminology.length === 1}
                        onClick={() =>
                          setTerminology((entries) =>
                            entries.filter(
                              (_, entryIndex) => entryIndex !== index,
                            ),
                          )
                        }
                        size="small"
                        type="button"
                        variant="quiet"
                      >
                        <Trash2 aria-hidden="true" size={15} />
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  disabled={terminology.length >= 64}
                  onClick={() =>
                    setTerminology((entries) => [...entries, emptyTerm()])
                  }
                  size="small"
                  type="button"
                  variant="secondary"
                >
                  <Plus aria-hidden="true" size={15} />
                  {t("addTerm")}
                </Button>
              </div>
            </section>

            <section
              aria-labelledby="support-verification-heading"
              className="settings-form-section"
            >
              <h3 id="support-verification-heading">
                <ShieldCheck aria-hidden="true" size={16} />
                {t("verification")}
              </h3>
              <div className="settings-support-stack">
                <Checkbox
                  defaultChecked={policy.enabled}
                  name="verificationEnabled"
                >
                  {t("verificationEnabled")}
                </Checkbox>
                <fieldset className="settings-verification-factors">
                  <legend>{t("requiredFactors")}</legend>
                  {factors.map((factor) => (
                    <Checkbox
                      defaultChecked={policy.requiredFactors.includes(factor)}
                      key={factor}
                      name={`factor-${factor}`}
                    >
                      {t(`factors.${factor}`)}
                    </Checkbox>
                  ))}
                </fieldset>
                <div className="settings-form-grid">
                  <Input
                    defaultValue={policy.maxAttempts}
                    id="verification-max-attempts"
                    label={t("maxAttempts")}
                    max={10}
                    min={1}
                    name="maxAttempts"
                    required
                    type="number"
                  />
                  <Select
                    defaultValue={policy.onFailure}
                    id="verification-failure"
                    label={t("onFailure")}
                    name="onFailure"
                  >
                    <option value="human_handoff">{t("humanHandoff")}</option>
                    <option value="end_call">{t("endCall")}</option>
                  </Select>
                </div>
                <InlineFeedback description={t("disclosurePolicy")} />
              </div>
            </section>

            <div className="form-actions">
              <Button busy={pending} type="submit">
                {t("save")}
              </Button>
            </div>
          </fieldset>
        </form>
      </Surface>
    </>
  );
}
