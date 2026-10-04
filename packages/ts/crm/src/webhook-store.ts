import postgres from "postgres";
import { createHash } from "node:crypto";

import {
  parseWhatsAppMessageEnvelopes,
  parseWhatsAppStatusEnvelopes,
  verifyWhatsAppSignature,
} from "./webhook.js";

interface AcceptedEventRow {
  id: string;
}

export interface AcceptedWhatsAppWebhook {
  readonly eventIds: readonly string[];
  readonly envelopes: number;
  readonly skippedUnknownAccounts: number;
}

export class InvalidWhatsAppSignatureError extends Error {}
export class InvalidWhatsAppPayloadError extends Error {}

export async function acceptWhatsAppWebhook(
  databaseUrl: string,
  rawBody: Uint8Array,
  signatureHeader: string | null,
  appSecret: string,
  expectedProviderAccountId?: string,
  verificationDatabaseUrl?: string,
): Promise<AcceptedWhatsAppWebhook> {
  if (!verifyWhatsAppSignature(rawBody, signatureHeader, appSecret)) {
    throw new InvalidWhatsAppSignatureError("Invalid WhatsApp signature");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
  } catch (error) {
    throw new InvalidWhatsAppPayloadError("Invalid WhatsApp JSON payload", {
      cause: error,
    });
  }
  const envelopes = parseWhatsAppMessageEnvelopes(payload);
  const statuses = parseWhatsAppStatusEnvelopes(payload);
  if (
    expectedProviderAccountId !== undefined &&
    [...envelopes, ...statuses].some(
      (event) => event.providerAccountId !== expectedProviderAccountId,
    )
  )
    throw new InvalidWhatsAppPayloadError(
      "WhatsApp account does not match webhook endpoint",
    );
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    let skippedUnknownAccounts = 0;
    const verifiedMessageEvents: {
      eventId: string;
      expectedPayload: string;
    }[] = [];
    const eventIds = await sql.begin(async (transaction) => {
      const ids: string[] = [];
      for (const envelope of envelopes) {
        const contentType = envelope.contentType ?? "text";
        const expectedPayload = {
          providerAccountId: envelope.providerAccountId,
          providerEventId: envelope.providerEventId,
          providerMessageId: envelope.providerMessageId,
          from: envelope.from,
          profileName: envelope.profileName,
          text: envelope.text,
          contentType,
          ...(envelope.providerMessageType === undefined
            ? {}
            : { providerMessageType: envelope.providerMessageType }),
          ...(envelope.interaction === undefined
            ? {}
            : { interaction: envelope.interaction }),
          ...(envelope.reaction === undefined
            ? {}
            : { reaction: envelope.reaction }),
          ...(envelope.media === undefined ? {} : { media: envelope.media }),
          ...(envelope.location === undefined
            ? {}
            : { location: envelope.location }),
          ...(envelope.occurredAt === undefined
            ? {}
            : { occurredAt: envelope.occurredAt }),
          ...(envelope.replyToProviderMessageId === undefined
            ? {}
            : {
                replyToProviderMessageId: envelope.replyToProviderMessageId,
              }),
        };
        const rows = await transaction
          .savepoint(
            async (savepoint) => savepoint<AcceptedEventRow[]>`
          SELECT (ops.accept_whatsapp_inbound(
            ${envelope.providerAccountId}, ${envelope.providerEventId},
            ${`whatsapp.message.${contentType}`}, ${savepoint.json(expectedPayload)}
          )).id
        `,
          )
          .catch((error: unknown) => {
            if (
              error instanceof postgres.PostgresError &&
              error.code === "22023" &&
              error.message === "unknown or inactive WhatsApp provider account"
            ) {
              skippedUnknownAccounts += 1;
              return [];
            }
            throw error;
          });
        if (rows.length === 0) continue;
        const id = rows[0]?.id;
        if (id === undefined) throw new Error("webhook event insert failed");
        ids.push(id);
        verifiedMessageEvents.push({
          eventId: id,
          expectedPayload: JSON.stringify(expectedPayload),
        });
      }
      for (const status of statuses) {
        const rows = await transaction
          .savepoint(
            async (savepoint) => savepoint<AcceptedEventRow[]>`
          SELECT (ops.accept_whatsapp_inbound(
            ${status.providerAccountId}, ${status.providerEventId},
            'whatsapp.message.status', ${savepoint.json({
              providerAccountId: status.providerAccountId,
              providerEventId: status.providerEventId,
              providerMessageId: status.providerMessageId,
              status: status.status,
              occurredAt: status.occurredAt,
              ...(status.errorCode === undefined
                ? {}
                : { errorCode: status.errorCode }),
            })}
          )).id
        `,
          )
          .catch((error: unknown) => {
            if (
              error instanceof postgres.PostgresError &&
              error.code === "22023" &&
              error.message === "unknown or inactive WhatsApp provider account"
            ) {
              skippedUnknownAccounts += 1;
              return [];
            }
            throw error;
          });
        if (rows.length === 0) continue;
        const id = rows[0]?.id;
        if (id === undefined)
          throw new Error("webhook status event insert failed");
        ids.push(id);
      }
      return ids;
    });
    if (
      verificationDatabaseUrl !== undefined &&
      verifiedMessageEvents.length > 0
    ) {
      // This branch is reachable only after raw HMAC and server account binding.
      // The ordinary app/worker role has no signature attestation capability.
      const verifier = postgres(verificationDatabaseUrl, {
        max: 1,
        prepare: false,
        connect_timeout: 2,
      });
      try {
        const digest = createHash("sha256").update(rawBody).digest("hex");
        await verifier.begin(async (transaction) => {
          await transaction`SET LOCAL statement_timeout='2000ms'`;
          await transaction`SET LOCAL ROLE platform_whatsapp_verifier`;
          const contract = await transaction<{ valid: boolean }[]>`
            SELECT current_user='platform_whatsapp_verifier'
              AND NOT (role.rolcanlogin OR role.rolsuper OR role.rolbypassrls OR role.rolinherit
                OR role.rolcreaterole OR role.rolcreatedb OR role.rolreplication)
              AND NOT EXISTS(SELECT 1 FROM pg_auth_members membership
                WHERE membership.roleid=role.oid OR membership.member=role.oid)
              AND NOT EXISTS(SELECT 1 FROM pg_class relation CROSS JOIN LATERAL aclexplode(relation.relacl) acl WHERE acl.grantee=role.oid)
              AND (SELECT count(*) FROM pg_proc routine CROSS JOIN LATERAL aclexplode(routine.proacl) acl
                WHERE acl.grantee=role.oid AND acl.privilege_type='EXECUTE'
                  AND routine.oid::regprocedure::text='agents.attest_whatsapp_signature(uuid,text,jsonb)' AND NOT acl.is_grantable)=1
              AND NOT EXISTS(SELECT 1 FROM pg_proc routine CROSS JOIN LATERAL aclexplode(routine.proacl) acl
                WHERE acl.grantee=role.oid AND (routine.oid::regprocedure::text<>'agents.attest_whatsapp_signature(uuid,text,jsonb)' OR acl.is_grantable)) valid
            FROM pg_roles role WHERE role.rolname=current_user
          `;
          if (contract[0]?.valid !== true)
            throw new TypeError("invalid WhatsApp verifier capability");
          for (const proof of verifiedMessageEvents)
            await transaction`SELECT agents.attest_whatsapp_signature(${proof.eventId}::uuid,${digest},${proof.expectedPayload}::text::jsonb)`;
        });
      } catch {
        // Normal ingress already committed. Missing proof prevents private
        // memory reuse; it cannot lose the accepted customer message.
        console.warn("WhatsApp memory signature evidence unavailable", {
          reason: "verification_persistence_failed",
        });
      } finally {
        await verifier.end({ timeout: 1 });
      }
    }
    return { eventIds, envelopes: eventIds.length, skippedUnknownAccounts };
  } finally {
    await sql.end({ timeout: 2 });
  }
}
