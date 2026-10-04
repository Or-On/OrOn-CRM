"""Expose a channel envelope only to its fresh owned outbound job.

Revision ID: ef9751e264d9
Revises: ee8460d153c8
"""

from alembic import op

revision = "ef9751e264d9"
down_revision = "ee8460d153c8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE FUNCTION platform.messaging_outbound_channel_credential(
        p_job uuid,p_worker text,p_claim uuid) RETURNS jsonb
      LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT CASE WHEN c.credential_id IS NULL THEN jsonb_build_object('legacy',true)
          ELSE jsonb_build_object('tenantId',c.tenant_id,'channelId',c.id,
            'credentialId',c.credential_id,'kind',cr.kind,'algorithm',cr.algorithm,
            'keyVersion',cr.key_version,'ciphertext',encode(cr.ciphertext,'hex'),
            'nonce',encode(cr.nonce,'hex')) END
        FROM ops.jobs j JOIN messaging.outbound_requests r
          ON r.id=j.reference_id AND r.tenant_id=j.tenant_id
        JOIN messaging.channels c ON c.id=r.channel_id AND c.tenant_id=r.tenant_id
        JOIN public.tenants t ON t.id=j.tenant_id AND t.status='active'
        LEFT JOIN platform.credential_records cr
          ON cr.id=c.credential_id AND cr.tenant_id=c.tenant_id
        WHERE j.id=p_job AND j.tenant_id=platform.current_tenant_id()
          AND j.job_type='whatsapp.outbound.send' AND j.status='running'
          AND j.locked_by=p_worker AND j.claim_token=p_claim
          AND j.lease_expires_at>clock_timestamp()
          AND r.status='sending' AND r.provider='meta'
          AND c.provider='meta' AND c.kind='whatsapp' AND c.status='active'
          AND platform.messaging_ai_actor_authorized(r.requested_by_user_id)
      $$
    """)
    op.execute("""
      REVOKE ALL ON FUNCTION platform.messaging_outbound_channel_credential(uuid,text,uuid)
      FROM PUBLIC
    """)
    op.execute("""
      GRANT EXECUTE ON FUNCTION platform.messaging_outbound_channel_credential(uuid,text,uuid)
      TO platform_messaging
    """)


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.messaging_outbound_channel_credential(uuid,text,uuid)")
