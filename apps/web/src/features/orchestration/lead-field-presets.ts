/**
 * Starting points for a field list. A preset only fills the editor: the
 * operator can change every field before publishing, and any list they write
 * from scratch is equally valid. Neither preset asks for a phone number or an
 * email, because the interaction already carries the contact's channel
 * identity, and neither asks for a national identifier.
 */

export type LeadFieldDraftType =
  | "text"
  | "number"
  | "currency"
  | "date"
  | "email"
  | "phone"
  | "boolean"
  | "choice";

export interface LeadFieldDraft {
  readonly key: string;
  readonly label: string;
  readonly type: LeadFieldDraftType;
  readonly required: boolean;
  /** Comma-separated while editing; split on submit. */
  readonly choices: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

export const businessSoftwarePreset: readonly LeadFieldDraft[] = [
  {
    key: "preferred_name",
    label: "Preferred name",
    type: "text",
    required: true,
    choices: "",
  },
  {
    key: "company",
    label: "Company",
    type: "text",
    required: true,
    choices: "",
  },
  {
    key: "requested_service",
    label: "Requested service",
    type: "text",
    required: true,
    choices: "",
  },
  {
    key: "user_count",
    label: "Approximate number of users",
    type: "number",
    required: false,
    choices: "",
    minimum: 1,
  },
  {
    key: "budget",
    label: "Budget",
    type: "currency",
    required: false,
    choices: "",
    minimum: 0,
  },
  {
    key: "start_timeframe",
    label: "Desired start timeframe",
    type: "text",
    required: false,
    choices: "",
  },
  {
    key: "follow_up_channel",
    label: "Preferred follow-up channel",
    type: "choice",
    required: false,
    choices: "Phone call, WhatsApp, Email",
  },
  {
    key: "follow_up_time",
    label: "Preferred follow-up time",
    type: "text",
    required: false,
    choices: "",
  },
];

/** Deliberately different questions, types and required set. */
export const propertyViewingPreset: readonly LeadFieldDraft[] = [
  {
    key: "preferred_name",
    label: "Preferred name",
    type: "text",
    required: true,
    choices: "",
  },
  {
    key: "property_reference",
    label: "Property of interest",
    type: "text",
    required: true,
    choices: "",
  },
  {
    key: "viewing_date",
    label: "Requested viewing date",
    type: "date",
    required: true,
    choices: "",
  },
  {
    key: "party_size",
    label: "People attending",
    type: "number",
    required: false,
    choices: "",
    minimum: 1,
    maximum: 20,
  },
  {
    key: "mortgage_preapproved",
    label: "Mortgage pre-approved",
    type: "boolean",
    required: false,
    choices: "",
  },
  {
    key: "maximum_budget",
    label: "Maximum budget",
    type: "currency",
    required: false,
    choices: "",
    minimum: 0,
  },
  {
    key: "contact_window",
    label: "Best time to reach them",
    type: "choice",
    required: false,
    choices: "Morning, Afternoon, Evening",
  },
];

/** A readable key from an English label; empty when the label is not ASCII. */
export function keyFromLabel(label: string): string {
  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .replace(/^[0-9_]+/u, "")
    .slice(0, 63);
  return key;
}

/** The definition the schema API validates against the shared contract. */
export function fieldDefinitions(
  fields: readonly LeadFieldDraft[],
): readonly Record<string, unknown>[] {
  return fields.map((field) => ({
    key: field.key.trim(),
    label: field.label.trim(),
    type: field.type,
    required: field.required,
    ...(field.type === "choice"
      ? {
          choices: field.choices
            .split(",")
            .map((choice) => choice.trim())
            .filter(Boolean),
        }
      : {}),
    ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
    ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
  }));
}
