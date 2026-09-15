export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value))
    throw new TypeError(`${label} must be a valid identifier`);
  return value;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} is required`);
  return value;
}

export function optionalText(value: unknown, label: string) {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string")
    throw new TypeError(`${label} must be text or null`);
  return value;
}
