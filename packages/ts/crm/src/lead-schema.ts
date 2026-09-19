/**
 * TypeScript consumer of the canonical lead capture contract.
 *
 * The rules live in `db/contracts/lead-capture.v1.json`; this module reads its
 * generated mirror, and so does the Python voice runtime. Both run the same
 * parity fixtures from that file, so a normalization rule cannot drift between
 * the channels without one of the two test suites failing. Neither runtime
 * writes lead rows itself: both hand the normalized result to the same
 * `platform.*` PostgreSQL functions, which own binding, idempotency, revision
 * checks and the durable receipt.
 *
 * Three invariants drive the design:
 *  - Missing is not zero and refusal is not consent, so a field carries a state
 *    rather than a sentinel value.
 *  - The customer's own words are evidence; the normalized form is the value.
 *    Both are kept, separately.
 *  - Nothing is inferred. An unparseable date is an error the agent must resolve
 *    with the customer, never a guess written to the record.
 */

import { leadCaptureContract } from "./lead-capture-contract.generated.js";
import { normalizeE164 } from "./phone.js";
import type { JsonValue } from "./types.js";

const contract = leadCaptureContract;
const limits = contract.limits;

export const leadFieldTypes = contract.enums.fieldTypes;
export type LeadFieldType = (typeof leadFieldTypes)[number];

export const leadFieldStates = contract.enums.fieldStates;
export type LeadFieldState = (typeof leadFieldStates)[number];

export const leadFieldConfirmations = contract.enums.confirmations;
export type LeadFieldConfirmation = (typeof leadFieldConfirmations)[number];

export type LeadFieldErrorCode = (typeof contract.errorCodes)[number];

export interface LeadFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: LeadFieldType;
  readonly required: boolean;
  readonly description?: string;
  readonly choices?: readonly string[];
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface LeadFieldSchema {
  readonly schemaVersion: "1.0";
  readonly fields: readonly LeadFieldDefinition[];
}

function pattern(source: string, flags = ""): RegExp {
  return new RegExp(source, `u${flags}`);
}

const trimmable = pattern(contract.patterns.trimmable, "g");
const fieldKeyPattern = pattern(contract.patterns.fieldKey);
const emailPattern = pattern(contract.patterns.email);
const phoneSeparators = pattern(contract.patterns.phoneSeparators, "g");
const numberSpacing = pattern(contract.patterns.numberSpacing, "g");
const thousandsComma = pattern(contract.patterns.thousandsComma, "g");
const decimalNumber = pattern(contract.patterns.decimalNumber);
const isoDatePattern = pattern(contract.patterns.isoDate);
const isoInstantPattern = pattern(contract.patterns.isoInstant);
const currencyPattern = pattern(contract.patterns.currency);
const israeliNationalPattern = pattern(contract.phoneRegions.IL.national);

export const maximumLeadFields = limits.schemaFields;

/** The contract's trim: the same characters Python strips, not `String#trim`'s. */
export function trimLeadText(value: string): string {
  return value.replace(trimmable, "");
}

function definitionError(message: string): never {
  throw new TypeError(`lead field schema: ${message}`);
}

function parseChoices(value: unknown, key: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > limits.choices
  )
    definitionError(
      `${key} requires between 1 and ${String(limits.choices)} choices`,
    );
  const choices = value.map((choice) => {
    if (typeof choice !== "string")
      definitionError(`${key} has an invalid choice`);
    const trimmed = trimLeadText(choice);
    if (!trimmed || trimmed.length > limits.choiceLength)
      definitionError(`${key} has an invalid choice`);
    return trimmed;
  });
  if (
    new Set(choices.map((choice) => choice.toLowerCase())).size !==
    choices.length
  )
    definitionError(`${key} has duplicate choices`);
  return choices;
}

function parseDefinition(value: unknown): LeadFieldDefinition {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    definitionError("each field must be an object");
  const record = value as Readonly<Record<string, unknown>>;
  const key = typeof record.key === "string" ? trimLeadText(record.key) : "";
  if (!fieldKeyPattern.test(key))
    definitionError(`invalid field key: ${JSON.stringify(record.key)}`);
  const label =
    typeof record.label === "string" ? trimLeadText(record.label) : "";
  if (!label || label.length > limits.labelLength)
    definitionError(
      `${key} requires a label of 1–${String(limits.labelLength)} characters`,
    );
  if (
    typeof record.type !== "string" ||
    !leadFieldTypes.includes(record.type as LeadFieldType)
  )
    definitionError(`${key} has an unsupported type`);
  const type = record.type as LeadFieldType;
  if (typeof record.required !== "boolean")
    definitionError(`${key} must declare required explicitly`);
  const description =
    typeof record.description === "string"
      ? trimLeadText(record.description)
      : "";
  if (description.length > limits.descriptionLength)
    definitionError(
      `${key} description exceeds ${String(limits.descriptionLength)} characters`,
    );
  const maxLength = record.maxLength;
  if (
    maxLength !== undefined &&
    (typeof maxLength !== "number" ||
      !Number.isInteger(maxLength) ||
      maxLength < 1 ||
      maxLength > limits.maxLengthCeiling)
  )
    definitionError(
      `${key} maxLength must be an integer between 1 and ${String(limits.maxLengthCeiling)}`,
    );
  for (const bound of ["minimum", "maximum"] as const) {
    const candidate = record[bound];
    if (
      candidate !== undefined &&
      (typeof candidate !== "number" || !Number.isFinite(candidate))
    )
      definitionError(`${key} ${bound} must be a finite number`);
  }
  const minimum = record.minimum as number | undefined;
  const maximum = record.maximum as number | undefined;
  if (minimum !== undefined && maximum !== undefined && minimum > maximum)
    definitionError(`${key} minimum exceeds maximum`);
  if (type !== "choice" && record.choices !== undefined)
    definitionError(`${key} may only declare choices for a choice field`);
  return {
    key,
    label,
    type,
    required: record.required,
    ...(description ? { description } : {}),
    ...(type === "choice"
      ? { choices: parseChoices(record.choices, key) }
      : {}),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  };
}

export function parseLeadFieldSchema(value: unknown): LeadFieldSchema {
  const fields = Array.isArray(value)
    ? value
    : value !== null &&
        typeof value === "object" &&
        Array.isArray((value as { fields?: unknown }).fields)
      ? (value as { fields: readonly unknown[] }).fields
      : definitionError("definition must be an array of fields");
  if (fields.length === 0) definitionError("at least one field is required");
  if (fields.length > maximumLeadFields)
    definitionError(
      `at most ${String(maximumLeadFields)} fields are supported`,
    );
  const parsed = fields.map(parseDefinition);
  const keys = new Set(parsed.map((field) => field.key));
  if (keys.size !== parsed.length) definitionError("field keys must be unique");
  return { schemaVersion: "1.0", fields: parsed };
}

export function leadFieldSchemaJson(schema: LeadFieldSchema): JsonValue {
  return schema.fields.map((field) => ({ ...field }));
}

export interface LeadFieldObservationInput {
  readonly key: string;
  readonly state: LeadFieldState;
  readonly value?: string;
  readonly currency?: string;
  readonly confirmation?: LeadFieldConfirmation;
  readonly observedAt?: string;
  readonly sourceReferenceId?: string;
}

export interface NormalizedLeadField {
  readonly key: string;
  readonly type: LeadFieldType;
  readonly state: LeadFieldState;
  readonly rawValue: string | null;
  readonly normalizedValue: string | null;
  readonly currency: string | null;
  readonly confirmation: LeadFieldConfirmation;
  readonly observedAt: string;
  readonly sourceReferenceId: string | null;
}

export class LeadFieldValidationError extends Error {
  readonly field: string;
  readonly reason: string;
  /** The contract's stable code; `reason` is only its English rendering. */
  readonly code: LeadFieldErrorCode;
  constructor(field: string, reason: string, code: LeadFieldErrorCode) {
    super(`${field}: ${reason}`);
    this.name = "LeadFieldValidationError";
    this.field = field;
    this.reason = reason;
    this.code = code;
  }
}

export interface LeadNormalizationOptions {
  /** Approved dialling region for local-format phone numbers. */
  readonly phoneRegion?: "IL";
  /** Tenant clock, used only to reject dates, never to invent one. */
  readonly today?: string;
}

function realCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * An observation time is an exact instant with an explicit offset. Checked
 * field by field rather than through `Date.parse`, whose leniency differs
 * between engines and has no Python equivalent.
 */
function validInstant(value: string): boolean {
  if (!isoInstantPattern.test(value)) return false;
  const [date = "", rest = ""] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined)
    return false;
  if (year < limits.dateYearMin || year > limits.dateYearMax) return false;
  if (!realCalendarDate(year, month, day)) return false;
  const [hour, minute, second = 0] = rest
    .replace(/(?:Z|[+-][0-9]{2}:[0-9]{2})$/u, "")
    .split(":")
    .map(Number);
  if (hour === undefined || minute === undefined) return false;
  if (hour > 23 || minute > 59 || Math.floor(second) > 59) return false;
  const offset = /([+-])([0-9]{2}):([0-9]{2})$/u.exec(rest);
  return (
    offset === null || (Number(offset[2]) <= 23 && Number(offset[3]) <= 59)
  );
}

function normalizePhone(
  raw: string,
  options: LeadNormalizationOptions,
  key: string,
): string {
  const compact = raw.replace(phoneSeparators, "");
  const explicit = normalizeE164(compact);
  if (explicit !== undefined) return explicit;
  if (options.phoneRegion === "IL") {
    const national = israeliNationalPattern.exec(compact);
    const candidate = national?.[1];
    if (candidate !== undefined) {
      const normalized = normalizeE164(
        `+${contract.phoneRegions.IL.countryCode}${candidate}`,
      );
      if (normalized !== undefined) return normalized;
    }
  }
  throw new LeadFieldValidationError(
    key,
    "a phone number must be international (+…) or a recognised local number",
    "invalid_phone",
  );
}

function normalizeNumber(raw: string, key: string): number {
  // Accept both decimal separators; a thousands separator is dropped only when
  // it cannot be the decimal point. Only plain decimal notation is a number: a
  // customer saying "0x10" has not given a head count of sixteen.
  const compact = raw
    .replace(numberSpacing, "")
    .replace(thousandsComma, "")
    .replace(",", ".");
  if (!decimalNumber.test(compact))
    throw new LeadFieldValidationError(
      key,
      "expected a number",
      "invalid_number",
    );
  const parsed = Number(compact);
  if (!Number.isFinite(parsed) || Math.abs(parsed) >= limits.absoluteNumber)
    throw new LeadFieldValidationError(
      key,
      "is implausibly large",
      "number_too_large",
    );
  return parsed;
}

function applyBounds(definition: LeadFieldDefinition, parsed: number): void {
  if (definition.minimum !== undefined && parsed < definition.minimum)
    throw new LeadFieldValidationError(
      definition.key,
      `must be at least ${String(definition.minimum)}`,
      "below_minimum",
    );
  if (definition.maximum !== undefined && parsed > definition.maximum)
    throw new LeadFieldValidationError(
      definition.key,
      `must be at most ${String(definition.maximum)}`,
      "above_maximum",
    );
}

function normalizeKnownValue(
  definition: LeadFieldDefinition,
  raw: string,
  input: LeadFieldObservationInput,
  options: LeadNormalizationOptions,
): { readonly normalized: string; readonly currency: string | null } {
  const key = definition.key;
  switch (definition.type) {
    case "text":
    case "choice": {
      const limit = definition.maxLength ?? limits.defaultTextLength;
      if (raw.length > limit)
        throw new LeadFieldValidationError(
          key,
          `must be at most ${String(limit)} characters`,
          "text_too_long",
        );
      if (definition.type === "text")
        return { normalized: raw, currency: null };
      const match = definition.choices?.find(
        (choice) => choice.toLowerCase() === raw.toLowerCase(),
      );
      if (match === undefined)
        throw new LeadFieldValidationError(
          key,
          `must be one of: ${(definition.choices ?? []).join(", ")}`,
          "invalid_choice",
        );
      return { normalized: match, currency: null };
    }
    case "email": {
      const normalized = raw.toLowerCase();
      if (!emailPattern.test(normalized))
        throw new LeadFieldValidationError(
          key,
          "expected an email address",
          "invalid_email",
        );
      return { normalized, currency: null };
    }
    case "phone":
      return { normalized: normalizePhone(raw, options, key), currency: null };
    case "boolean": {
      const lowered = raw.toLowerCase();
      if ((contract.booleanTokens.true as readonly string[]).includes(lowered))
        return { normalized: "true", currency: null };
      if ((contract.booleanTokens.false as readonly string[]).includes(lowered))
        return { normalized: "false", currency: null };
      throw new LeadFieldValidationError(
        key,
        "expected yes or no",
        "invalid_boolean",
      );
    }
    case "number": {
      const parsed = normalizeNumber(raw, key);
      applyBounds(definition, parsed);
      return { normalized: String(parsed), currency: null };
    }
    case "currency": {
      const currency = trimLeadText(input.currency ?? "").toUpperCase();
      if (!currencyPattern.test(currency))
        throw new LeadFieldValidationError(
          key,
          "an amount requires an ISO 4217 currency code",
          "currency_required",
        );
      const parsed = normalizeNumber(raw, key);
      if (parsed < 0)
        throw new LeadFieldValidationError(
          key,
          "must not be negative",
          "negative_amount",
        );
      applyBounds(definition, parsed);
      return {
        normalized: parsed.toFixed(contract.rounding.currencyDecimals),
        currency,
      };
    }
    case "date": {
      const match = isoDatePattern.exec(raw);
      if (match === null)
        throw new LeadFieldValidationError(
          key,
          "expected an exact calendar date (YYYY-MM-DD)",
          "invalid_date_format",
        );
      const year = Number(match[1]);
      if (year < limits.dateYearMin || year > limits.dateYearMax)
        throw new LeadFieldValidationError(
          key,
          `must fall between ${String(limits.dateYearMin)} and ${String(limits.dateYearMax)}`,
          "date_out_of_range",
        );
      if (!realCalendarDate(year, Number(match[2]), Number(match[3])))
        throw new LeadFieldValidationError(
          key,
          "is not a real calendar date",
          "invalid_calendar_date",
        );
      return { normalized: raw, currency: null };
    }
  }
}

export function normalizeLeadField(
  schema: LeadFieldSchema,
  input: LeadFieldObservationInput,
  options: LeadNormalizationOptions = {},
): NormalizedLeadField {
  const definition = schema.fields.find((field) => field.key === input.key);
  if (definition === undefined)
    throw new LeadFieldValidationError(
      input.key,
      "is not part of this lead's reviewed field schema",
      "unknown_field",
    );
  if (!leadFieldStates.includes(input.state))
    throw new LeadFieldValidationError(
      input.key,
      "has an unsupported state",
      "unsupported_state",
    );
  const confirmation = input.confirmation ?? "unconfirmed";
  if (!leadFieldConfirmations.includes(confirmation))
    throw new LeadFieldValidationError(
      input.key,
      "has an unsupported confirmation status",
      "unsupported_confirmation",
    );
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (!validInstant(observedAt))
    throw new LeadFieldValidationError(
      input.key,
      "has an invalid observation time",
      "invalid_observed_at",
    );
  const reference =
    input.sourceReferenceId === undefined
      ? ""
      : trimLeadText(input.sourceReferenceId);
  if (reference.length > limits.sourceReferenceLength)
    throw new LeadFieldValidationError(
      input.key,
      "source reference is too long",
      "reference_too_long",
    );
  const sourceReferenceId = reference.length > 0 ? reference : null;
  if (input.state !== "known") {
    if (input.value !== undefined && trimLeadText(input.value))
      throw new LeadFieldValidationError(
        input.key,
        "only a known value may carry content",
        "content_without_known",
      );
    return {
      key: definition.key,
      type: definition.type,
      state: input.state,
      rawValue: null,
      normalizedValue: null,
      currency: null,
      confirmation,
      observedAt,
      sourceReferenceId,
    };
  }
  const raw = trimLeadText(input.value ?? "");
  if (!raw)
    throw new LeadFieldValidationError(
      input.key,
      "a known value cannot be blank; use unknown, declined or not_applicable",
      "blank_known",
    );
  if (raw.length > limits.rawValueLength)
    throw new LeadFieldValidationError(
      input.key,
      `value exceeds ${String(limits.rawValueLength)} characters`,
      "value_too_long",
    );
  const { normalized, currency } = normalizeKnownValue(
    definition,
    raw,
    input,
    options,
  );
  return {
    key: definition.key,
    type: definition.type,
    state: "known",
    rawValue: raw,
    normalizedValue: normalized,
    currency,
    confirmation,
    observedAt,
    sourceReferenceId,
  };
}

export interface LeadCompleteness {
  readonly required: readonly string[];
  readonly satisfied: readonly string[];
  readonly missing: readonly string[];
  readonly declined: readonly string[];
  readonly complete: boolean;
}

/**
 * Deterministic completeness. A declined required field is resolved, not
 * missing: the customer answered, and re-asking is harassment.
 */
export function leadCompleteness(
  schema: LeadFieldSchema,
  current: readonly Pick<NormalizedLeadField, "key" | "state">[],
): LeadCompleteness {
  const byKey = new Map(current.map((field) => [field.key, field.state]));
  const required = schema.fields
    .filter((field) => field.required)
    .map((field) => field.key);
  const satisfied: string[] = [];
  const missing: string[] = [];
  const declined: string[] = [];
  for (const key of required) {
    const state = byKey.get(key);
    if (state === "known") satisfied.push(key);
    else if (state === "declined" || state === "not_applicable") {
      declined.push(key);
      satisfied.push(key);
    } else missing.push(key);
  }
  return {
    required,
    satisfied,
    missing,
    declined,
    complete: missing.length === 0,
  };
}
