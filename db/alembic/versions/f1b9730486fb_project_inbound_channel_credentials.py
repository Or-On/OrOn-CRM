"""Project channel credentials under current committed ingress authority."""

from alembic import op

revision = "f1b9730486fb"
down_revision = "f0a862f375ea"
branch_labels = None
depends_on = None

# Human media mirroring remains independent of AI authorisation. AI media and
# typing require current published-agent authority; neither accepts caller scope.
SQL = r"""
CREATE FUNCTION platform.messaging_media_channel_credential(
 p_job uuid,p_worker text,p_token uuid,p_epoch bigint) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN ch.credential_id IS NULL THEN jsonb_build_object('legacy',true)
 ELSE jsonb_build_object('tenantId',ch.tenant_id,'channelId',ch.id,
 'credentialId',ch.credential_id,'kind',cr.kind,'algorithm',cr.algorithm,
 'keyVersion',cr.key_version,'ciphertext',encode(cr.ciphertext,'hex'),
 'nonce',encode(cr.nonce,'hex')) END
 FROM ops.jobs j
 JOIN messaging.messages m ON m.tenant_id=j.tenant_id AND m.id=j.reference_id
 JOIN messaging.conversations c ON c.tenant_id=m.tenant_id AND c.id=m.conversation_id
 JOIN messaging.channels ch ON ch.tenant_id=c.tenant_id AND ch.id=c.channel_id
 JOIN messaging.inbound_message_origins origin ON origin.tenant_id=m.tenant_id
   AND origin.message_id=m.id
 JOIN crm.contact_channel_identities identity ON identity.tenant_id=origin.tenant_id
   AND identity.id=origin.contact_identity_id AND identity.contact_id=c.contact_id
   AND identity.channel='whatsapp' AND identity.provider='meta'
   AND identity.validation_status='valid' AND identity.normalized_value=origin.sender_address
 JOIN public.tenants t ON t.id=j.tenant_id AND t.status='active'
 LEFT JOIN platform.credential_records cr ON cr.tenant_id=ch.tenant_id AND cr.id=ch.credential_id
 WHERE j.tenant_id=platform.current_tenant_id() AND j.id=p_job
   AND j.queue='messaging' AND j.job_type='whatsapp.media.retrieve'
   AND j.reference_type='message' AND j.status='running'
   AND j.locked_by=p_worker AND j.claim_token=p_token
   AND j.lease_expires_at>clock_timestamp()
   AND j.payload->>'messageId'=m.id::text
   AND j.payload->>'conversationId'=c.id::text
   AND j.payload->>'mediaId'=m.structured_content->>'providerMediaId'
   AND j.payload->>'contentType'=m.content_type
   AND m.provider='meta' AND m.direction='inbound' AND m.status='received'
   AND m.content_type IN ('image','document','audio') AND m.object_id IS NULL
   AND ch.kind='whatsapp' AND ch.provider='meta' AND ch.status='active'
   AND ch.mirror_inbound_media AND c.removed_from_inbox_at IS NULL
   AND platform.current_tenant_feature_enabled('whatsapp')
   AND (c.ownership_mode='human' OR (c.ownership_mode='ai'
     AND c.ownership_epoch=p_epoch
     AND platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id)
     AND EXISTS(SELECT 1 FROM agents.agent_profile_versions a
       JOIN agents.agent_profiles p ON p.tenant_id=a.tenant_id AND p.id=a.agent_profile_id
       WHERE a.tenant_id=c.tenant_id AND a.id=c.ai_agent_profile_version_id
       AND a.published_at IS NOT NULL AND a.validation_status='valid'
       AND 'whatsapp'=ANY(a.channel_capabilities) AND p.archived_at IS NULL)))
$$;
CREATE FUNCTION platform.messaging_typing_channel_credential(p_message uuid,p_epoch bigint)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN ch.credential_id IS NULL THEN jsonb_build_object('legacy',true)
 ELSE jsonb_build_object('tenantId',ch.tenant_id,'channelId',ch.id,
 'credentialId',ch.credential_id,'kind',cr.kind,'algorithm',cr.algorithm,
 'keyVersion',cr.key_version,'ciphertext',encode(cr.ciphertext,'hex'),
 'nonce',encode(cr.nonce,'hex')) END
 FROM messaging.messages m
 JOIN messaging.conversations c ON c.tenant_id=m.tenant_id AND c.id=m.conversation_id
 JOIN messaging.channels ch ON ch.tenant_id=c.tenant_id AND ch.id=c.channel_id
 JOIN messaging.inbound_message_origins origin ON origin.tenant_id=m.tenant_id
   AND origin.message_id=m.id
 JOIN crm.contact_channel_identities identity ON identity.tenant_id=origin.tenant_id
   AND identity.id=origin.contact_identity_id AND identity.contact_id=c.contact_id
   AND identity.channel='whatsapp' AND identity.provider='meta'
   AND identity.validation_status='valid' AND identity.normalized_value=origin.sender_address
 JOIN public.tenants t ON t.id=m.tenant_id AND t.status='active'
 JOIN agents.agent_profile_versions a ON a.tenant_id=c.tenant_id
   AND a.id=c.ai_agent_profile_version_id
 JOIN agents.agent_profiles p ON p.tenant_id=a.tenant_id AND p.id=a.agent_profile_id
 LEFT JOIN platform.credential_records cr ON cr.tenant_id=ch.tenant_id AND cr.id=ch.credential_id
 WHERE m.tenant_id=platform.current_tenant_id() AND m.id=p_message
   AND m.direction='inbound' AND m.status='received' AND m.provider='meta'
   AND c.ownership_mode='ai' AND c.ownership_epoch=p_epoch
   AND c.removed_from_inbox_at IS NULL
   AND ch.kind='whatsapp' AND ch.provider='meta' AND ch.status='active'
   AND platform.current_tenant_feature_enabled('whatsapp')
   AND EXISTS(SELECT 1 FROM platform.tenant_remediation_flags f
     WHERE f.tenant_id=c.tenant_id AND f.flag_key='typing' AND f.enabled)
   AND platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id)
   AND a.published_at IS NOT NULL AND a.validation_status='valid'
   AND 'whatsapp'=ANY(a.channel_capabilities) AND p.archived_at IS NULL
   AND m.id=(SELECT recent.id FROM messaging.messages recent
     LEFT JOIN ops.inbound_events event ON event.tenant_id=recent.tenant_id
       AND event.provider=recent.provider AND event.provider_account_id=ch.provider_account_id
       AND event.payload->>'providerMessageId'=recent.provider_message_id
     WHERE recent.tenant_id=m.tenant_id AND recent.conversation_id=c.id
       AND recent.direction='inbound' AND recent.content_type<>'event'
     ORDER BY COALESCE(event.received_at,recent.created_at) DESC,
       event.receipt_sequence DESC NULLS LAST,recent.created_at DESC,
       recent.updated_at DESC,recent.id DESC LIMIT 1)
   AND NOT EXISTS(SELECT 1 FROM ops.inbound_events event
     JOIN ops.inbound_events newer ON newer.tenant_id=event.tenant_id
       AND newer.provider=event.provider
       AND newer.provider_account_id=event.provider_account_id
       AND newer.receipt_sequence>event.receipt_sequence
       AND newer.status IN ('received','processing','failed')
       AND (newer.status='processing' OR newer.attempts<newer.max_attempts)
       AND newer.event_type IN ('whatsapp.message.text','whatsapp.message.image',
         'whatsapp.message.document','whatsapp.message.location','whatsapp.message.audio',
         'whatsapp.message.video','whatsapp.message.interactive')
       AND newer.payload->>'providerMessageId'<>m.provider_message_id
       AND regexp_replace(newer.payload->>'from','[^0-9]','','g')
         =regexp_replace(origin.sender_address,'[^0-9]','','g')
     WHERE event.tenant_id=m.tenant_id AND event.provider='meta'
       AND event.provider_account_id=ch.provider_account_id
       AND event.payload->>'providerMessageId'=m.provider_message_id)
$$;
"""


def upgrade() -> None:
    for statement in SQL.split("$$;"):
        if statement.strip():
            op.execute(statement + "$$;")
    for signature in (
        "platform.messaging_media_channel_credential(uuid,text,uuid,bigint)",
        "platform.messaging_typing_channel_credential(uuid,bigint)",
    ):
        op.execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
        op.execute(f"GRANT EXECUTE ON FUNCTION {signature} TO platform_messaging")


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.messaging_typing_channel_credential(uuid,bigint)")
    op.execute("DROP FUNCTION platform.messaging_media_channel_credential(uuid,text,uuid,bigint)")
