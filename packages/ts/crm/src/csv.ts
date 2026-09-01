import type { ContactImportRow } from "./types.js";

function parseLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else value += character;
  }
  if (quoted) throw new TypeError("CSV contains an unclosed quote");
  values.push(value.trim());
  return values;
}

export function parseContactCsv(source: string): readonly ContactImportRow[] {
  const lines = source
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .filter((line) => line.trim());
  if (lines.length < 2)
    throw new TypeError("CSV must include a header and at least one row");
  const header = parseLine(lines[0] ?? "").map((value) => value.toLowerCase());
  const position = (names: readonly string[]) =>
    header.findIndex((value) => names.includes(value));
  const nameIndex = position(["name", "full name", "full_name"]);
  const phoneIndex = position(["phone", "whatsapp", "mobile"]);
  const emailIndex = position(["email", "email address"]);
  const companyIndex = position(["company", "organization"]);
  if (nameIndex < 0) throw new TypeError("CSV requires a name column");
  return lines.slice(1).map((line, index) => {
    const values = parseLine(line);
    const name = values[nameIndex]?.trim() ?? "";
    if (name === "")
      throw new TypeError(`CSV row ${String(index + 2)} requires a name`);
    const optional = (column: number) => {
      const candidate = values[column];
      return column < 0 || candidate === undefined || candidate.trim() === ""
        ? undefined
        : candidate.trim();
    };
    const phone = optional(phoneIndex);
    const email = optional(emailIndex);
    const company = optional(companyIndex);
    return {
      name,
      ...(phone === undefined ? {} : { phone }),
      ...(email === undefined ? {} : { email }),
      ...(company === undefined ? {} : { company }),
    };
  });
}
