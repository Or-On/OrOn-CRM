import type postgres from "postgres";

/** A web-form request can only be submitted through the signed public form. */
export async function digitalServiceFormPending(
  sql: postgres.TransactionSql,
  conversationId: string,
): Promise<boolean> {
  const rows = await sql<{ pending: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM messaging.conversations conversation
      JOIN service.intake_drafts intake ON intake.tenant_id=conversation.tenant_id
        AND (intake.conversation_id=conversation.id
          OR intake.reporting_contact_id=conversation.contact_id
          OR intake.customer_contact_id=conversation.contact_id)
      WHERE conversation.id=${conversationId}::uuid
        AND conversation.tenant_id=platform.current_tenant_id()
        AND intake.status IN ('collecting','awaiting_confirmation')
        AND intake.workflow_policy->'whatsappFollowUp'->>'mode'='form'
    ) AS pending
  `;
  return rows[0]?.pending === true;
}

/** A verified caller reopening the window can receive the previously blocked link. */
export async function resumeDigitalFormFollowup(
  sql: postgres.TransactionSql,
  messageId: string,
): Promise<boolean> {
  const candidates = await sql<
    { id: string; conversation_id: string; followup_status: string }[]
  >`
    SELECT intake.id, conversation.id AS conversation_id,intake.followup_status
    FROM messaging.messages message
    JOIN messaging.conversations conversation ON conversation.tenant_id=message.tenant_id
      AND conversation.id=message.conversation_id
    JOIN messaging.channels channel ON channel.tenant_id=conversation.tenant_id
      AND channel.id=conversation.channel_id AND channel.provider='meta' AND channel.status='active'
    JOIN messaging.inbound_message_origins origin ON origin.tenant_id=message.tenant_id
      AND origin.message_id=message.id
    JOIN crm.contact_channel_identities identity ON identity.tenant_id=message.tenant_id
      AND identity.id=origin.contact_identity_id AND identity.contact_id=conversation.contact_id
      AND identity.normalized_value=origin.sender_address
    JOIN crm.contacts contact ON contact.tenant_id=conversation.tenant_id
      AND contact.id=conversation.contact_id AND contact.whatsapp_consent='granted'
      AND contact.whatsapp_opted_out_at IS NULL
    JOIN service.intake_drafts intake ON intake.tenant_id=conversation.tenant_id
      AND intake.reporting_contact_id=conversation.contact_id
      AND (intake.conversation_id=conversation.id OR intake.conversation_id IS NULL)
    WHERE message.id=${messageId}::uuid AND message.tenant_id=platform.current_tenant_id()
      AND message.direction='inbound' AND message.sender_type='contact' AND message.provider='meta'
      AND message.content_type<>'event' AND conversation.removed_from_inbox_at IS NULL
      AND conversation.customer_service_window_expires_at>clock_timestamp()
      AND intake.status IN ('collecting','awaiting_confirmation')
      AND (intake.followup_status='blocked_window' OR (intake.followup_status='queued' AND EXISTS(
        SELECT 1 FROM ops.jobs followup WHERE followup.tenant_id=intake.tenant_id AND followup.reference_id=intake.id
          AND followup.job_type='field_service.intake_followup' AND followup.status IN ('queued','running','retry'))))
      AND intake.source_session_id IS NOT NULL
      AND intake.workflow_policy#>>'{whatsappFollowUp,mode}'='form'
      AND intake.workflow_policy#>>'{whatsappFollowUp,enabled}'='true'
      AND platform.current_tenant_feature_enabled('whatsapp')
      AND platform.current_tenant_feature_enabled('field_service')
      AND service.verified_followup_recipient(intake.id,conversation.id,identity.id,identity.normalized_value)
      AND channel.id=(SELECT selected.id FROM messaging.channels selected
        WHERE selected.tenant_id=conversation.tenant_id AND selected.kind='whatsapp'
          AND selected.provider IN ('meta','simulator') AND selected.status='active'
        ORDER BY CASE selected.provider WHEN 'meta' THEN 0 ELSE 1 END,selected.created_at,selected.id LIMIT 1)
    ORDER BY intake.id LIMIT 2 FOR UPDATE OF intake
  `;
  // Several outstanding inquiries require staff correlation, not several links.
  const intake = candidates.length === 1 ? candidates[0] : undefined;
  if (intake === undefined) return false;
  if (intake.followup_status === "queued") return true;
  const jobs = await sql<{ id: string }[]>`
    INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,
      idempotency_key,max_attempts,priority)
    VALUES(platform.current_tenant_id(),'messaging','field_service.intake_followup','intake_draft',
      ${intake.id}::uuid,jsonb_build_object('intakeId',${intake.id}::uuid,'cause','customer_reopened_window'),
      ${`service-followup:${intake.id}`},5,20)
    ON CONFLICT ((COALESCE(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid)),queue,idempotency_key)
      WHERE idempotency_key IS NOT NULL
    DO UPDATE SET status='queued',available_at=clock_timestamp(),
      attempts=0,last_error_safe=NULL,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
      completed_at=NULL,updated_at=clock_timestamp()
      WHERE ops.jobs.status='succeeded' AND ops.jobs.job_type='field_service.intake_followup'
        AND ops.jobs.reference_id=EXCLUDED.reference_id
    RETURNING id
  `;
  if (jobs.length !== 1) return false;
  await sql`UPDATE service.intake_drafts SET followup_status='queued',followup_error_safe=NULL,
    conversation_id=coalesce(conversation_id,${intake.conversation_id}::uuid),updated_at=clock_timestamp()
    WHERE id=${intake.id}::uuid AND tenant_id=platform.current_tenant_id() AND followup_status='blocked_window'`;
  await sql`INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
    VALUES(platform.current_tenant_id(),'messaging-worker','field_service.intake.form_window_reopened',
      'intake_draft',${intake.id}::uuid,${sql.json({ messageId, jobId: jobs[0]?.id })})`;
  return true;
}
