"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import type { AgentCapability, LeadFieldSchemaRecord } from "@or-on/crm";
import { Button, Checkbox, Input, Select } from "@or-on/ui";
import { Plus, Trash2 } from "lucide-react";

import { crmMutation, crmRead } from "../crm";
import { capabilityCopy } from "./agent-capability-copy";
import {
  businessSoftwarePreset,
  fieldDefinitions,
  keyFromLabel,
  propertyViewingPreset,
  type LeadFieldDraft,
  type LeadFieldDraftType,
} from "./lead-field-presets";

/** The actions an operator grants; lead reading is implied by any lead grant. */
const grantable = [
  "lead.write",
  "lead.finalize",
  "lead.follow_up",
  "ticket.open",
  "service.intake",
] as const;

function collectsLeads(capabilities: readonly AgentCapability[]): boolean {
  return capabilities.some((capability) => capability.startsWith("lead."));
}
const fieldTypes: readonly LeadFieldDraftType[] = [
  "text",
  "number",
  "currency",
  "date",
  "email",
  "phone",
  "boolean",
  "choice",
];

export interface LeadCapabilityConfiguration {
  readonly capabilities: readonly AgentCapability[];
  readonly roleTitle: string;
  readonly schemaMode: "existing" | "new";
  readonly schemaId: string;
  readonly schemaName: string;
  readonly fields: readonly LeadFieldDraft[];
}

export function emptyLeadConfiguration(
  initial: Partial<LeadCapabilityConfiguration> = {},
): LeadCapabilityConfiguration {
  return {
    capabilities: [],
    roleTitle: "",
    schemaMode: initial.schemaId ? "existing" : "new",
    schemaId: "",
    schemaName: "",
    fields: [],
    ...initial,
  };
}

/**
 * Turn the operator's choices into the agent request fields, publishing a new
 * field list first when they defined one. The prompt is never read here: a
 * capability exists only because a box was ticked.
 */
export async function leadRequestFields(
  configuration: LeadCapabilityConfiguration,
): Promise<Record<string, unknown>> {
  const capabilities = [...configuration.capabilities];
  const roleTitle = configuration.roleTitle.trim();
  const base = {
    capabilities,
    ...(roleTitle === "" ? {} : { roleTitle }),
  };
  if (!collectsLeads(capabilities)) return base;
  if (configuration.schemaMode === "existing")
    return { ...base, leadFieldSchemaId: configuration.schemaId };
  const created = await crmMutation<{ readonly id: string }>(
    "/api/leads/schemas",
    {
      name: configuration.schemaName,
      fields: fieldDefinitions(configuration.fields),
    },
  );
  return { ...base, leadFieldSchemaId: created.id };
}

export function LeadCapabilityFieldset({
  idPrefix,
  value,
  onChange,
  disabled = false,
}: {
  readonly idPrefix: string;
  readonly value: LeadCapabilityConfiguration;
  readonly onChange: (next: LeadCapabilityConfiguration) => void;
  readonly disabled?: boolean;
}) {
  const locale = useLocale();
  const copy = capabilityCopy(locale);
  const [schemas, setSchemas] = useState<readonly LeadFieldSchemaRecord[]>();
  const [loadFailed, setLoadFailed] = useState(false);
  const collects = collectsLeads(value.capabilities);

  useEffect(() => {
    if (!collects || schemas !== undefined) return;
    const controller = new AbortController();
    crmRead<{ readonly schemas: readonly LeadFieldSchemaRecord[] }>(
      "/api/leads/schemas",
      controller.signal,
    )
      .then((payload) => setSchemas(payload.schemas))
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    return () => controller.abort();
  }, [collects, schemas]);

  function update(patch: Partial<LeadCapabilityConfiguration>) {
    onChange({ ...value, ...patch });
  }

  function updateField(index: number, patch: Partial<LeadFieldDraft>) {
    update({
      fields: value.fields.map((field, position) => {
        if (position !== index) return field;
        const next = { ...field, ...patch };
        // Follow the label while the key has not been typed by hand.
        if (
          patch.label !== undefined &&
          (field.key === "" || field.key === keyFromLabel(field.label))
        )
          return { ...next, key: keyFromLabel(patch.label) };
        return next;
      }),
    });
  }

  return (
    <fieldset className="agent-capabilities" disabled={disabled}>
      <legend>{copy.capabilitiesTitle}</legend>
      <p className="agent-capabilities__hint">{copy.capabilitiesHint}</p>
      {grantable.map((capability) => (
        <Checkbox
          key={capability}
          checked={value.capabilities.includes(capability)}
          onChange={(event) =>
            update({
              capabilities: event.target.checked
                ? [...value.capabilities, capability]
                : value.capabilities.filter((entry) => entry !== capability),
            })
          }
        >
          {copy.capability[capability]}
        </Checkbox>
      ))}
      <Input
        id={`${idPrefix}-role-title`}
        label={copy.roleTitle}
        maxLength={60}
        value={value.roleTitle}
        onChange={(event) => update({ roleTitle: event.target.value })}
      />
      {collects ? (
        <>
          <Select
            id={`${idPrefix}-schema`}
            label={copy.schemaChoice}
            value={value.schemaMode === "new" ? "" : value.schemaId}
            onChange={(event) =>
              update(
                event.target.value === ""
                  ? { schemaMode: "new", schemaId: "" }
                  : { schemaMode: "existing", schemaId: event.target.value },
              )
            }
          >
            <option value="">{copy.schemaNew}</option>
            {(schemas ?? []).map((schema) => (
              <option key={schema.id} value={schema.id}>
                {`${schema.name} v${String(schema.version)} · ${String(schema.schema.fields.length)}`}
              </option>
            ))}
          </Select>
          {schemas === undefined && !loadFailed ? (
            <p role="status">{copy.schemaLoading}</p>
          ) : null}
          {loadFailed ? <p role="alert">{copy.schemaFailed}</p> : null}
          {value.schemaMode === "new" ? (
            <div className="agent-capabilities__fields">
              <Input
                id={`${idPrefix}-schema-name`}
                label={copy.schemaName}
                maxLength={120}
                required
                value={value.schemaName}
                onChange={(event) => update({ schemaName: event.target.value })}
              />
              <div
                className="agent-capabilities__presets"
                role="group"
                aria-label={copy.presets}
              >
                <span>{copy.presets}</span>
                <Button
                  size="small"
                  variant="quiet"
                  onClick={() =>
                    update({
                      fields: businessSoftwarePreset,
                      schemaName: value.schemaName || copy.presetBusiness,
                    })
                  }
                >
                  {copy.presetBusiness}
                </Button>
                <Button
                  size="small"
                  variant="quiet"
                  onClick={() =>
                    update({
                      fields: propertyViewingPreset,
                      schemaName: value.schemaName || copy.presetProperty,
                    })
                  }
                >
                  {copy.presetProperty}
                </Button>
              </div>
              <ol className="agent-capabilities__field-list">
                {value.fields.map((field, index) => (
                  <li key={index}>
                    <Input
                      id={`${idPrefix}-field-${String(index)}-label`}
                      label={copy.fieldLabel}
                      dir="auto"
                      required
                      value={field.label}
                      onChange={(event) =>
                        updateField(index, { label: event.target.value })
                      }
                    />
                    <Input
                      id={`${idPrefix}-field-${String(index)}-key`}
                      label={copy.fieldKey}
                      dir="ltr"
                      pattern="[a-z][a-z0-9_]{0,62}"
                      required
                      value={field.key}
                      onChange={(event) =>
                        updateField(index, { key: event.target.value })
                      }
                    />
                    <Select
                      id={`${idPrefix}-field-${String(index)}-type`}
                      label={copy.fieldType}
                      value={field.type}
                      onChange={(event) =>
                        updateField(index, {
                          type: event.target.value as LeadFieldDraftType,
                        })
                      }
                    >
                      {fieldTypes.map((type) => (
                        <option key={type} value={type}>
                          {copy.types[type]}
                        </option>
                      ))}
                    </Select>
                    {field.type === "choice" ? (
                      <Input
                        id={`${idPrefix}-field-${String(index)}-choices`}
                        label={copy.fieldChoices}
                        dir="auto"
                        required
                        value={field.choices}
                        onChange={(event) =>
                          updateField(index, { choices: event.target.value })
                        }
                      />
                    ) : null}
                    <Checkbox
                      checked={field.required}
                      onChange={(event) =>
                        updateField(index, { required: event.target.checked })
                      }
                    >
                      {copy.fieldRequired}
                    </Checkbox>
                    <Button
                      size="small"
                      variant="quiet"
                      onClick={() =>
                        update({
                          fields: value.fields.filter(
                            (_, position) => position !== index,
                          ),
                        })
                      }
                    >
                      <Trash2 aria-hidden="true" size={15} />
                      {copy.removeField}
                    </Button>
                  </li>
                ))}
              </ol>
              <Button
                size="small"
                variant="secondary"
                onClick={() =>
                  update({
                    fields: [
                      ...value.fields,
                      {
                        key: "",
                        label: "",
                        type: "text",
                        required: false,
                        choices: "",
                      },
                    ],
                  })
                }
              >
                <Plus aria-hidden="true" size={15} />
                {copy.addField}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </fieldset>
  );
}
