import type postgres from "postgres";

export interface CallableVoiceFlow {
  readonly flow_id: string;
  readonly name: string;
  readonly language: string;
  readonly packaged: false;
  /** The approved retained script version, distinct from the agent version. */
  readonly latest_version: number;
  readonly flow_version: number;
  readonly agent_version: number;
  readonly agent_version_id: string;
}

/** Shared by call selection and final admission: display exactly what a new call pins. */
export async function listCallableVoiceFlows(
  sql: postgres.TransactionSql,
  flowId?: string,
): Promise<readonly CallableVoiceFlow[]> {
  const rows = await sql<
    Omit<CallableVoiceFlow, "packaged" | "latest_version">[]
  >`

        WITH process_binding AS (
          SELECT process.id, process.agent_profile_version_id, process.flow_version_id
          FROM automation.tenant_processes process
          WHERE process.tenant_id = platform.current_tenant_id()
            AND process.enabled
            AND process.trigger_key = 'voice.outbound_assignment'
            AND (process.channel = 'voice' OR process.channel IS NULL)
          ORDER BY process.priority, process.id LIMIT 1
        ), candidates AS (
          SELECT
            canonical.*,
            row_number() OVER (
              PARTITION BY canonical.flow_definition_id
              ORDER BY canonical.version DESC
            ) AS latest
          FROM automation.flow_versions canonical
          JOIN automation.flow_definitions definition
            ON definition.id = canonical.flow_definition_id
           AND definition.tenant_id = canonical.tenant_id
           AND definition.archived_at IS NULL
          WHERE canonical.tenant_id = platform.current_tenant_id()
            AND canonical.published_at IS NOT NULL
            AND (
              platform.approved_flow_for_channel(
                canonical.id, canonical.agent_profile_version_id, 'voice')
              OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements(canonical.definition -> 'nodes') candidate_node
                JOIN agents.agent_profile_versions candidate_agent
                  ON candidate_agent.tenant_id = canonical.tenant_id
                 AND candidate_agent.id::text =
                   candidate_node #>> '{configuration,agentVersionId}'
                WHERE candidate_node ->> 'type' = 'voice.call'
                  AND platform.approved_flow_for_channel(
                    canonical.id, candidate_agent.id, 'voice')
              )
            )
        )
        SELECT DISTINCT
          agent.id::text AS agent_version_id,
          agent.version AS agent_version,
          voice.flow_id::text AS flow_id,
          coalesce(voice.source#>>'{flow,name}', voice.flow_id::text) AS name,
          coalesce(voice.source#>>'{flow,language}', 'he') AS language,
          (node #>> '{configuration,flowVersion}')::integer AS flow_version
        FROM candidates canonical
        LEFT JOIN process_binding binding ON true
        CROSS JOIN LATERAL
          jsonb_array_elements(canonical.definition -> 'nodes') node
        JOIN agents.agent_profile_versions agent
          ON agent.tenant_id = canonical.tenant_id
         AND (
           (
             node #>> '{configuration,agentVersionId}' IS NULL
             AND agent.id = canonical.agent_profile_version_id
           )
           OR node #>> '{configuration,agentVersionId}' = agent.id::text
         )
        JOIN public.flows voice
          ON voice.tenant_id = canonical.tenant_id
         AND voice.flow_id::text = node #>> '{configuration,flowId}'
         AND voice.version =
           (node #>> '{configuration,flowVersion}')::integer
        WHERE (binding.id IS NOT NULL OR canonical.latest = 1)
          AND canonical.validation_status = 'valid'
          AND platform.current_tenant_feature_enabled('voice')
          AND agent.published_at IS NOT NULL
          AND agent.validation_status = 'valid'
          AND 'voice' = ANY(agent.channel_capabilities)
          AND platform.approved_flow_for_channel(canonical.id, agent.id, 'voice')
          AND (binding.id IS NULL OR (
            canonical.id = binding.flow_version_id
            AND agent.id = binding.agent_profile_version_id
          ))
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(agent.tool_permissions) capability(value)
            WHERE (capability.value LIKE 'lead.%'
                   AND NOT platform.current_tenant_feature_enabled('leads'))
               OR (capability.value = 'ticket.open'
                   AND NOT platform.current_tenant_feature_enabled('tickets'))
               OR (capability.value = 'service.intake' AND (
                   NOT platform.current_tenant_feature_enabled('field_service')
                   OR NOT platform.current_tenant_feature_enabled('tickets')))
          )
          AND node ->> 'type' = 'voice.call'
          AND (${flowId ?? null}::text IS NULL OR node #>> '{configuration,flowId}' = ${flowId ?? null}::text)
      `;
  return rows.map((row) => ({
    ...row,
    packaged: false,
    latest_version: row.flow_version,
  }));
}
