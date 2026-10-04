"""Allow bounded private video retrieval through the existing owned media port."""

from alembic import op

revision = "fb5d740e2a9f"
down_revision = "fa4c629d1f8e"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""DO $$ DECLARE body text; anchor text;
      BEGIN
        body:=pg_get_functiondef(
          'platform.messaging_media_channel_credential(uuid,text,uuid,bigint)'::regprocedure);
        anchor:=$anchor$m.content_type IN ('image','document','audio')$anchor$;
        IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN
          RAISE EXCEPTION 'private_video_media_authority_guard_drift';
        END IF;
        EXECUTE replace(body,anchor,
          $replacement$m.content_type IN ('image','document','audio','video')$replacement$);
      END $$""")
    op.execute("""DO $$ DECLARE body text; anchor text;
      BEGIN
        body:=pg_get_functiondef('messaging.current_tenant_message_media(uuid)'::regprocedure);
        anchor:=$anchor$message.content_type IN ('image', 'document', 'audio')$anchor$;
        IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN
          RAISE EXCEPTION 'private_video_read_authority_guard_drift';
        END IF;
        body:=replace(body,anchor,
          $replacement$message.content_type IN ('image', 'document', 'audio', 'video')$replacement$
        );
        anchor:=$anchor$OR (message.content_type = 'audio'
                  AND object.content_type IN ('audio/ogg', 'audio/wav'))$anchor$;
        IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN
          RAISE EXCEPTION 'private_video_read_mime_guard_drift';
        END IF;
        EXECUTE replace(body,anchor,anchor||
          $replacement$ OR (message.content_type = 'video'
                  AND object.content_type = 'video/mp4')$replacement$);
      END $$""")

    op.execute("""CREATE FUNCTION platform.authorize_media_commit(
      p_job uuid,p_worker text,p_token uuid,p_epoch bigint,p_account text)
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE job_row ops.jobs%ROWTYPE; message_row messaging.messages%ROWTYPE;
        conversation_row messaging.conversations%ROWTYPE;
        channel_row messaging.channels%ROWTYPE; envelope jsonb;
      BEGIN
        SELECT * INTO job_row FROM ops.jobs WHERE tenant_id=platform.current_tenant_id()
          AND id=p_job AND queue='messaging' AND job_type='whatsapp.media.retrieve'
          AND reference_type='message' AND status='running' AND locked_by=p_worker
          AND claim_token=p_token AND lease_expires_at>clock_timestamp() FOR UPDATE;
        IF NOT FOUND THEN RETURN false; END IF;
        SELECT conversation.* INTO conversation_row FROM messaging.conversations conversation
          JOIN messaging.messages message ON message.tenant_id=conversation.tenant_id
            AND message.conversation_id=conversation.id
          WHERE message.tenant_id=job_row.tenant_id AND message.id=job_row.reference_id
          FOR SHARE OF conversation;
        IF NOT FOUND THEN RETURN false; END IF;
        SELECT * INTO message_row FROM messaging.messages
          WHERE tenant_id=job_row.tenant_id AND id=job_row.reference_id FOR SHARE;
        SELECT * INTO channel_row FROM messaging.channels
          WHERE tenant_id=job_row.tenant_id AND id=conversation_row.channel_id FOR SHARE;
        IF NOT FOUND OR channel_row.provider_account_id IS DISTINCT FROM p_account
          OR conversation_row.ownership_epoch IS DISTINCT FROM p_epoch THEN RETURN false; END IF;
        PERFORM 1 FROM messaging.inbound_message_origins origin
          JOIN crm.contact_channel_identities identity ON identity.tenant_id=origin.tenant_id
            AND identity.id=origin.contact_identity_id
          WHERE origin.tenant_id=job_row.tenant_id AND origin.message_id=message_row.id
          FOR SHARE OF origin,identity;
        IF NOT FOUND THEN RETURN false; END IF;
        PERFORM 1 FROM crm.contacts WHERE tenant_id=job_row.tenant_id
          AND id=conversation_row.contact_id FOR SHARE;
        PERFORM 1 FROM public.tenants WHERE id=job_row.tenant_id FOR SHARE;
        PERFORM 1 FROM platform.tenant_feature_entitlements WHERE tenant_id=job_row.tenant_id
          AND feature_key='whatsapp' FOR SHARE;
        IF conversation_row.ownership_mode='ai' THEN
          PERFORM 1 FROM public.users WHERE id=conversation_row.ai_enabled_by_user_id FOR SHARE;
          PERFORM 1 FROM public.memberships WHERE tenant_id=job_row.tenant_id
            AND user_id=conversation_row.ai_enabled_by_user_id FOR SHARE;
          PERFORM 1 FROM agents.agent_profile_versions version
            JOIN agents.agent_profiles profile ON profile.tenant_id=version.tenant_id
              AND profile.id=version.agent_profile_id
            WHERE version.tenant_id=job_row.tenant_id
              AND version.id=conversation_row.ai_agent_profile_version_id
            FOR SHARE OF version,profile;
        END IF;
        IF channel_row.credential_id IS NOT NULL THEN
          PERFORM 1 FROM platform.credential_records WHERE tenant_id=job_row.tenant_id
            AND id=channel_row.credential_id FOR SHARE;
        END IF;
        envelope:=platform.messaging_media_channel_credential(p_job,p_worker,p_token,p_epoch);
        RETURN COALESCE(envelope IS NOT NULL AND (envelope->>'legacy'='true' OR
          (envelope->>'kind'='whatsapp_access_token_v2'
            AND envelope->>'algorithm'='aes-256-gcm:whatsapp-channel:v2'
            AND envelope->>'keyVersion' IS NOT NULL
            AND length(envelope->>'ciphertext')>32 AND length(envelope->>'nonce')=24)),false);
      END $$""")
    op.execute("""REVOKE ALL ON FUNCTION
      platform.authorize_media_commit(uuid,text,uuid,bigint,text) FROM PUBLIC""")
    op.execute("""GRANT EXECUTE ON FUNCTION
      platform.authorize_media_commit(uuid,text,uuid,bigint,text) TO platform_messaging""")


def downgrade():
    op.execute("""DO $$ DECLARE body text; anchor text;
      BEGIN
        IF EXISTS(SELECT 1 FROM objects.object_metadata WHERE content_type='video/mp4')
          OR EXISTS(SELECT 1 FROM ops.jobs WHERE job_type='whatsapp.media.retrieve'
            AND payload->>'contentType'='video' AND status IN ('queued','running','retry')) THEN
          RAISE EXCEPTION 'private_video_evidence_requires_compatible_recovery';
        END IF;
        body:=pg_get_functiondef(
          'platform.messaging_media_channel_credential(uuid,text,uuid,bigint)'::regprocedure);
        anchor:=$anchor$m.content_type IN ('image','document','audio','video')$anchor$;
        IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN
          RAISE EXCEPTION 'private_video_media_authority_guard_drift';
        END IF;
        EXECUTE replace(body,anchor,
          $replacement$m.content_type IN ('image','document','audio')$replacement$);
      END $$""")
    op.execute("""DO $$ DECLARE body text; anchor text;
      BEGIN
        body:=pg_get_functiondef('messaging.current_tenant_message_media(uuid)'::regprocedure);
        anchor:=$anchor$message.content_type IN ('image', 'document', 'audio', 'video')$anchor$;
        IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN
          RAISE EXCEPTION 'private_video_read_authority_guard_drift';
        END IF;
        body:=replace(body,anchor,
          $replacement$message.content_type IN ('image', 'document', 'audio')$replacement$);
        anchor:=$anchor$ OR (message.content_type = 'video'
                  AND object.content_type = 'video/mp4')$anchor$;
        IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN
          RAISE EXCEPTION 'private_video_read_mime_guard_drift';
        END IF;
        EXECUTE replace(body,anchor,'');
      END $$""")

    op.execute("DROP FUNCTION platform.authorize_media_commit(uuid,text,uuid,bigint,text)")
