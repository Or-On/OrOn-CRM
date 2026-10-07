import type postgres from "postgres";
import { digitalServiceFormHash, issueDigitalServiceForm } from "@or-on/crm";

export function digitalFormReply(url: string, locale: string): string {
  return locale.toLowerCase().startsWith("he")
    ? `הנה הטופס לפנייה שלך: ${url}\nיש למלא שם, מיקום ותיאור התקלה, לצרף תמונות וללחוץ על שליחה. קריאת שירות תיפתח לאחר הגשת הטופס.`
    : `Here is your service request form: ${url}\nEnter your name, location and a description of the problem, attach photos and submit. A service case will open after you submit the form.`;
}

export async function startDigitalForm(
  sql: postgres.TransactionSql,
  job: { id: string; claim_token: string },
  workerId: string,
  publicSiteUrl: string,
): Promise<{ intakeId: string; url: string }> {
  // Validation happens before any row is created and again in the shared issuer.
  const origin = new URL(publicSiteUrl);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new TypeError("Service forms require an HTTPS origin");
  const rows = await sql<{ id: string }[]>`
    SELECT service.start_whatsapp_digital_intake(${job.id}::uuid,
      ${workerId},${job.claim_token}::uuid,${origin.origin}) AS id`;
  const intakeId = rows[0]?.id;
  if (!intakeId) throw new TypeError("Service form could not be started");
  const url = await issueDigitalServiceForm(sql, intakeId, publicSiteUrl);
  return { intakeId, url };
}

/** Reconstruct the exact server text from a live, conversation-bound receipt. */
export async function verifiedDigitalFormReply(
  sql: postgres.TransactionSql,
  input: {
    intakeId: string;
    conversationId: string;
    triggerMessageId: string;
    messageId: string;
    url: string;
    locale: string;
  },
): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return undefined;
  }
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("token") ?? "";
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/service-request" ||
    url.search ||
    !/^[0-9a-f]{64}$/u.test(token)
  )
    return undefined;
  const rows = await sql<{ allowed: boolean }[]>`
    SELECT service.whatsapp_digital_form_receipt(${input.intakeId}::uuid,${input.conversationId}::uuid,
      ${input.triggerMessageId}::uuid,${input.messageId}::uuid,${digitalServiceFormHash(token)},${url.origin})
      AND platform.current_tenant_id()::text=${fragment.get("tenant") ?? ""} AS allowed`;
  return rows[0]?.allowed === true
    ? digitalFormReply(input.url, input.locale)
    : undefined;
}
