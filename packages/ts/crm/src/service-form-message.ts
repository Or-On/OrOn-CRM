import type postgres from "postgres";
import { digitalServiceFormHash } from "./digital-service-form.js";

export const serviceFormTemplateV2Body =
  "שלום, כאן {{1}}. כדי לפתוח קריאת שירות מלאו את הטופס בקישור: {{2}}. לשאלות: {{3}}.";

export interface ServiceFormBrand {
  readonly businessName: string;
  readonly businessPhone: string | null;
}

/** Only the issuance-time, server-owned snapshot can author this message. */
export function serviceFormMessage(
  brand: ServiceFormBrand,
  link: string,
  trustedOrigin: string,
): string {
  const url = new URL(link);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (
    url.origin !== new URL(trustedOrigin).origin ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname !== "/service-request" ||
    !/^[0-9a-f]{64}$/u.test(fragment.get("token") ?? "") ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(
      fragment.get("tenant") ?? "",
    ) ||
    [...fragment.keys()].length !== 2
  ) {
    throw new TypeError("Invalid trusted service form link");
  }
  const name = serviceFormBusinessName(brand.businessName);
  const phone = brand.businessPhone;
  if (phone !== null && !/^\+[1-9][0-9]{7,14}$/u.test(phone))
    throw new TypeError("Invalid service business phone");
  return `שלום, כאן ${name}. כדי לפתוח קריאת שירות מלאו את הטופס בקישור: ${link}.${phone === null ? "" : ` לשאלות: ${phone}.`}`;
}

function serviceFormBusinessName(value: string): string {
  const name = value
    .replace(/[\p{Cc}\p{Cf}<>`{}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  if (!name || /https?:|www\./iu.test(name))
    throw new TypeError("Invalid service business name");
  return name;
}

export async function readServiceFormBrand(
  sql: postgres.TransactionSql,
  link: string,
): Promise<ServiceFormBrand | null> {
  const url = new URL(link);
  const token = new URLSearchParams(url.hash.slice(1)).get("token") ?? "";
  const rows = await sql<{ brand: ServiceFormBrand | null }[]>`
    SELECT service.digital_form_brand_snapshot(${digitalServiceFormHash(token)}) AS brand`;
  return rows[0]?.brand ?? null;
}

export async function readServiceFormMessage(
  sql: postgres.TransactionSql,
  link: string,
  legacyReply?: string,
): Promise<string> {
  const brand = await readServiceFormBrand(sql, link);
  if (!brand && legacyReply !== undefined) return legacyReply;
  if (!brand) throw new TypeError("Service form brand snapshot unavailable");
  // Callers separately validate this origin against their deployment/receipt binding.
  return serviceFormMessage(brand, link, new URL(link).origin);
}

export async function serviceFormTemplateParameters(
  sql: postgres.TransactionSql,
  link: string,
  parameterCount: number,
): Promise<readonly string[]> {
  if (parameterCount === 1) return [link];
  if (parameterCount !== 3)
    throw new TypeError("Unsupported service form template parameter count");
  const brand = await readServiceFormBrand(sql, link);
  if (!brand?.businessPhone)
    throw new TypeError("Service form v2 template requires business phone");
  serviceFormMessage(brand, link, new URL(link).origin);
  // A malformed legacy snapshot must be reviewed; never send template content
  // that differs from the database's immutable approval evidence.
  if (serviceFormBusinessName(brand.businessName) !== brand.businessName)
    throw new TypeError("Service form brand requires review");
  return [brand.businessName, link, brand.businessPhone];
}
