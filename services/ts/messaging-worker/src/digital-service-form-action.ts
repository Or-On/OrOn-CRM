import type postgres from "postgres";
import { digitalServiceFormHash, issueDigitalServiceForm } from "@or-on/crm";

export function digitalFormReply(url: string, locale: string): string {
  return locale.toLowerCase().startsWith("he")
    ? `הנה הטופס לפנייה שלך: ${url}\nיש למלא שם, מיקום ותיאור התקלה, לצרף תמונות וללחוץ על שליחה. קריאת שירות תיפתח לאחר הגשת הטופס.`
    : `Here is your service request form: ${url}\nEnter your name, location and a description of the problem, attach photos and submit. A service case will open after you submit the form.`;
}

/** Reuse only a still-live link issued to this exact verified sender. */
export async function existingDigitalForm(
  sql: postgres.TransactionSql,
  conversationId: string,
  triggerMessageId: string,
  publicSiteUrl: string,
): Promise<{ intakeId: string; url: string } | undefined> {
  const origin = new URL(publicSiteUrl).origin;
  const candidates = await sql<
    {
      id: string;
      content_text: string | null;
      structured_content: unknown;
    }[]
  >`
    SELECT intake.id,message.content_text,message.structured_content
    FROM service.intake_drafts intake
    JOIN messaging.messages message ON message.tenant_id=intake.tenant_id AND message.id=intake.followup_message_id
    WHERE intake.tenant_id=platform.current_tenant_id() AND intake.conversation_id=${conversationId}::uuid
      AND intake.status IN ('collecting','awaiting_confirmation') AND intake.followup_status='admitted'
      AND intake.workflow_policy#>>'{whatsappFollowUp,mode}'='form'
    ORDER BY intake.created_at DESC,intake.id DESC LIMIT 20`;
  for (const candidate of candidates) {
    const text = `${candidate.content_text ?? ""} ${JSON.stringify(candidate.structured_content)}`;
    for (const match of text.matchAll(/https:\/\/[^\s"\\<>]+/gu)) {
      const url = match[0];
      try {
        if (new URL(url).origin !== origin) continue;
      } catch {
        continue;
      }
      if (
        await verifiedExistingDigitalFormReply(sql, {
          intakeId: candidate.id,
          conversationId,
          triggerMessageId,
          messageId: null,
          url,
          locale: "he",
        })
      )
        return { intakeId: candidate.id, url };
    }
  }
  return undefined;
}

export async function verifiedExistingDigitalFormReply(
  sql: postgres.TransactionSql,
  input: {
    intakeId: string;
    conversationId: string;
    triggerMessageId: string;
    messageId: string | null;
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
    url.search ||
    url.pathname !== "/service-request" ||
    !/^[0-9a-f]{64}$/u.test(token)
  )
    return undefined;
  const rows = await sql<{ allowed: boolean }[]>`
    SELECT service.reusable_whatsapp_form_receipt(${input.intakeId}::uuid,${input.conversationId}::uuid,
      ${input.triggerMessageId}::uuid,${input.messageId}::uuid,${digitalServiceFormHash(token)},${input.url})
      AND platform.current_tenant_id()::text=${fragment.get("tenant") ?? ""} AS allowed`;
  return rows[0]?.allowed === true
    ? digitalFormReply(input.url, input.locale)
    : undefined;
}

export async function startDigitalForm(
  sql: postgres.TransactionSql,
  job: { id: string; claim_token: string },
  workerId: string,
  publicSiteUrl: string,
): Promise<{ intakeId: string; url: string; reused: boolean }> {
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
  const source = await sql<{ fresh: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM service.intake_drafts intake JOIN ops.jobs job
      ON job.tenant_id=intake.tenant_id AND job.id=${job.id}::uuid
      WHERE intake.tenant_id=platform.current_tenant_id() AND intake.id=${intakeId}::uuid
        AND intake.correlation_key='whatsapp-form:'||(job.payload->>'triggerMessageId')) AS fresh`;
  return { intakeId, url, reused: source[0]?.fresh !== true };
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
