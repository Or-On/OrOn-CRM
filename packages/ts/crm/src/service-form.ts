/** Retained workflow field names; customer answers are submitted through the web form. */
export const serviceFormFieldKeys = [
  "serviceLocation",
  "storeName",
  "customerName",
  "faultDescription",
  "chainName",
] as const;
export type ServiceFormField = (typeof serviceFormFieldKeys)[number];
export const defaultServiceFormFields: readonly ServiceFormField[] = [
  "serviceLocation",
  "storeName",
  "customerName",
];

export function parseServiceFormFields(
  value: unknown,
): readonly ServiceFormField[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > serviceFormFieldKeys.length ||
    new Set(value).size !== value.length ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        !(serviceFormFieldKeys as readonly string[]).includes(item),
    )
  )
    throw new TypeError("Choose up to five different service form fields");
  return value as ServiceFormField[];
}
