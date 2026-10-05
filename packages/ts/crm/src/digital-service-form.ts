import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";

export function digitalServiceFormHash(token: string): string {
  if (!/^[0-9a-f]{64}$/u.test(token))
    throw new TypeError("Service form link is invalid");
  return createHash("sha256").update(token).digest("hex");
}

/** Called inside the owned follow-up job's transaction before its text is queued. */
export async function issueDigitalServiceForm(
  sql: postgres.TransactionSql,
  intakeId: string,
  publicSiteUrl: string,
): Promise<string> {
  const origin = new URL(publicSiteUrl);
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new TypeError("Service form site must be an HTTP(S) origin");
  if (
    origin.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  )
    throw new TypeError("Public service forms require HTTPS");
  const token = randomBytes(32).toString("hex");
  const rows = await sql<{ tenant: string }[]>`
    SELECT service.issue_digital_intake_form(${intakeId}::uuid,${digitalServiceFormHash(token)}) AS tenant
  `;
  const tenant = rows[0]?.tenant;
  if (!tenant) throw new TypeError("Service form could not be issued");
  const url = new URL("/service-request", origin);
  // Fragments stay out of access logs, Referer headers and server rendering.
  url.hash = new URLSearchParams({ tenant, token }).toString();
  return url.toString();
}

export interface DigitalServiceForm {
  readonly intakeId: string;
  readonly businessName?: string;
  readonly customerName: string;
  readonly faultDescription: string;
  readonly photoRequired: boolean;
  readonly submitted: boolean;
  readonly reference: string | null;
}

export async function readDigitalServiceForm(
  sql: postgres.TransactionSql,
  token: string,
): Promise<DigitalServiceForm | null> {
  const rows = await sql<{ form: DigitalServiceForm | null }[]>`
    SELECT service.read_digital_intake_form(${digitalServiceFormHash(token)}) AS form
  `;
  return rows[0]?.form ?? null;
}

export interface DigitalServicePhoto {
  readonly contentType: string;
  readonly byteSize: number;
  readonly checksum: string;
  readonly storageBackend: string;
  readonly storageKey: string;
}

export async function submitDigitalServiceForm(
  sql: postgres.TransactionSql,
  token: string,
  input: {
    readonly customerName: string;
    readonly serviceLocation: string;
    readonly faultDescription: string;
    readonly confirmed: boolean;
    readonly photos: readonly DigitalServicePhoto[];
  },
): Promise<{ readonly reference: string; readonly created: boolean }> {
  const rows = await sql<
    { receipt: { reference: string; created: boolean } }[]
  >`
    SELECT service.submit_digital_intake_form(${digitalServiceFormHash(token)},${input.customerName},${input.serviceLocation},${input.faultDescription},${input.confirmed},${sql.json(input.photos.map((photo) => ({ contentType: photo.contentType, byteSize: photo.byteSize, checksum: photo.checksum, storageBackend: photo.storageBackend, storageKey: photo.storageKey })))}) AS receipt
  `;
  const receipt = rows[0]?.receipt;
  if (typeof receipt?.reference !== "string")
    throw new Error("Service form submission returned no reference");
  return receipt;
}
