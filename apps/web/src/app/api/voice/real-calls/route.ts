import { getContact } from "@or-on/crm";

import {
  assertAuthenticatedMutation,
  ForbiddenError,
  issueDispatcherGrant,
  jsonObject,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../../../features/auth";

export const dynamic = "force-dynamic";

function enabled(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === "true";
}

export async function POST(request: Request) {
  try {
    if (
      !enabled("ENABLE_REAL_TELEPHONY") ||
      !enabled("ENABLE_REAL_VOICE_PROVIDERS")
    ) {
      return Response.json(
        { error: "Real voice delivery is disabled" },
        { status: 503 },
      );
    }
    const session = await assertAuthenticatedMutation(request);
    const body = await jsonObject(request);
    if (
      typeof body.contactId !== "string" ||
      typeof body.flowId !== "string" ||
      typeof body.idempotencyKey !== "string" ||
      (body.callerGender !== "male" && body.callerGender !== "female")
    ) {
      throw new TypeError(
        "contactId, flowId, idempotencyKey, and callerGender are required",
      );
    }
    if (
      body.idempotencyKey.length < 8 ||
      body.idempotencyKey.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(body.idempotencyKey)
    ) {
      throw new TypeError("The real-call idempotency key is invalid");
    }
    if (body.explicitApproval !== true) {
      throw new TypeError(
        "A real telephone call requires explicit confirmation",
      );
    }

    const admission = await withCurrentTenant("voice:operate", async (sql) => {
      const contact = await getContact(sql, body.contactId as string);
      if (contact?.lifecycleStatus !== "active") {
        throw new TypeError("The selected contact is not callable");
      }
      if (contact.voiceConsent !== "granted") {
        throw new TypeError("Voice consent is required");
      }
      const identity = contact.identities.find(
        (candidate) =>
          (candidate.channel === "phone" || candidate.channel === "whatsapp") &&
          candidate.normalizedValue !== null &&
          candidate.validationStatus !== "invalid",
      );
      const normalizedDestination = identity?.normalizedValue;
      if (!normalizedDestination) {
        throw new TypeError("A valid E.164 phone identity is required");
      }
      const bindings = await sql<
        { agent_version_id: string; flow_version: number }[]
      >`
          WITH candidates AS (
            SELECT canonical.*,
              row_number() OVER (
                PARTITION BY canonical.flow_definition_id
                ORDER BY canonical.version DESC
              ) AS latest
            FROM automation.flow_versions canonical
            WHERE canonical.tenant_id = platform.current_tenant_id()
              AND canonical.published_at IS NOT NULL
          )
          SELECT DISTINCT agent.id::text AS agent_version_id,
            (node #>> '{configuration,flowVersion}')::integer AS flow_version
          FROM candidates canonical
          CROSS JOIN LATERAL
            jsonb_array_elements(canonical.definition -> 'nodes') node
          JOIN agents.agent_profile_versions agent
            ON agent.tenant_id = canonical.tenant_id
           AND (
             (node #>> '{configuration,agentVersionId}' IS NULL
              AND agent.id = canonical.agent_profile_version_id)
             OR node #>> '{configuration,agentVersionId}' = agent.id::text
           )
          JOIN public.flows voice
            ON voice.tenant_id = canonical.tenant_id
           AND voice.flow_id = ${body.flowId as string}::uuid
           AND voice.version =
             (node #>> '{configuration,flowVersion}')::integer
          WHERE canonical.latest = 1
            AND canonical.validation_status = 'valid'
            AND agent.published_at IS NOT NULL
            AND agent.validation_status = 'valid'
            AND 'voice' = ANY(agent.channel_capabilities)
            AND node ->> 'type' = 'voice.call'
            AND node #>> '{configuration,flowId}' = ${body.flowId as string}
        `;
      if (bindings.length !== 1 || bindings[0] === undefined) {
        throw new TypeError(
          bindings.length > 1
            ? "The selected voice flow has ambiguous agent bindings"
            : "The selected published voice flow and agent binding are unavailable",
        );
      }
      return {
        agentVersionId: bindings[0].agent_version_id,
        destination: normalizedDestination,
        flowVersion: bindings[0].flow_version,
      };
    });

    const assertion = await issueDispatcherGrant(session);
    const dispatcherUrl = new URL(
      "/api/v1/dispatch/outbound",
      process.env.DISPATCHER_URL ?? "http://127.0.0.1:8082",
    );
    const response = await fetch(dispatcherUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${assertion}`,
        "content-type": "application/json",
        "idempotency-key": body.idempotencyKey,
      },
      body: JSON.stringify({
        phone_number: admission.destination,
        contact_id: body.contactId,
        flow_id: body.flowId,
        flow_version: admission.flowVersion,
        agent_version_id: admission.agentVersionId,
        caller_gender: body.callerGender,
        idempotency_key: body.idempotencyKey,
        explicit_approval: true,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => null);
      const safeDetail =
        failure !== null &&
        typeof failure === "object" &&
        "detail" in failure &&
        typeof failure.detail === "string"
          ? failure.detail
          : null;
      return Response.json(
        {
          error:
            safeDetail ??
            "The voice dispatcher refused or could not start the call",
        },
        {
          status:
            response.status >= 400 && response.status < 600
              ? response.status
              : 503,
        },
      );
    }
    const result: unknown = await response.json();
    return Response.json(result, { status: response.status });
  } catch (error) {
    if (error instanceof UnauthenticatedError)
      return Response.json({ error: "Unauthenticated" }, { status: 401 });
    if (error instanceof ForbiddenError)
      return Response.json({ error: "Forbidden" }, { status: 403 });
    if (error instanceof TypeError)
      return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: "Real call unavailable" }, { status: 503 });
  }
}
