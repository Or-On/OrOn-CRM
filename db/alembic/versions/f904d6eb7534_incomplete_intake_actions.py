"""Tenant-scoped, idempotent staff recovery without manufacturing service cases."""

# ruff: noqa: E501
from alembic import op

revision = "f904d6eb7534"
down_revision = "f8f3c5da6423"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""CREATE FUNCTION service.can_manage_incomplete_intake() RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
      SELECT platform.current_tenant_active() AND service.field_service_enabled() AND EXISTS(
        SELECT 1 FROM public.memberships m JOIN public.users u ON u.id=m.user_id
        WHERE u.status='active' AND m.tenant_id=platform.current_tenant_id()
          AND m.user_id=platform.current_user_id() AND m.role IN ('owner','admin'))
      $$""")
    op.execute("REVOKE ALL ON FUNCTION service.can_manage_incomplete_intake() FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION service.can_manage_incomplete_intake() TO platform_web")
    op.execute("""CREATE TABLE service.intake_staff_actions(
      tenant_id uuid NOT NULL REFERENCES public.tenants(id), operation_id uuid NOT NULL,
      intake_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('retry','new_request','close')),
      actor_id uuid NOT NULL REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,operation_id), FOREIGN KEY(tenant_id,intake_id) REFERENCES service.intake_drafts(tenant_id,id))""")
    op.execute("ALTER TABLE service.intake_staff_actions ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE service.intake_staff_actions FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY intake_staff_actions_tenant ON service.intake_staff_actions USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id())"
    )
    op.execute("""CREATE FUNCTION service.act_on_incomplete_intake(p_intake uuid,p_action text,p_operation uuid) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE draft service.intake_drafts%ROWTYPE; prior messaging.outbound_requests%ROWTYPE; expires timestamptz;
        retained service.intake_staff_actions%ROWTYPE;
      BEGIN
        IF p_action NOT IN ('retry','new_request','close') OR NOT service.field_service_enabled() OR NOT EXISTS(
          SELECT 1 FROM public.memberships m JOIN public.users u ON u.id=m.user_id AND u.status='active'
          WHERE m.tenant_id=platform.current_tenant_id() AND m.user_id=platform.current_user_id() AND m.role IN ('owner','admin')) THEN
          RAISE EXCEPTION 'incomplete intake action denied' USING ERRCODE='42501'; END IF;
        SELECT * INTO draft FROM service.intake_drafts WHERE tenant_id=platform.current_tenant_id() AND id=p_intake FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'intake unavailable' USING ERRCODE='P0002'; END IF;
        SELECT * INTO retained FROM service.intake_staff_actions WHERE tenant_id=draft.tenant_id AND operation_id=p_operation;
        IF FOUND THEN
          IF retained.intake_id<>p_intake OR retained.action<>p_action THEN RAISE EXCEPTION 'operation content changed' USING ERRCODE='22023'; END IF;
          RETURN;
        END IF;
        IF draft.followup_closed_at IS NOT NULL OR draft.status NOT IN ('collecting','awaiting_confirmation','expired')
          OR draft.workflow_policy#>>'{whatsappFollowUp,mode}' IS DISTINCT FROM 'form' THEN
          RAISE EXCEPTION 'intake no longer actionable' USING ERRCODE='22023'; END IF;
        SELECT * INTO prior FROM messaging.outbound_requests WHERE tenant_id=draft.tenant_id AND message_id=draft.followup_message_id FOR UPDATE;
        SELECT expires_at INTO expires FROM service.digital_intake_forms WHERE tenant_id=draft.tenant_id AND intake_id=draft.id FOR UPDATE;
        IF p_action<>'close' THEN
          IF draft.followup_attempt>=3 OR prior.status='sending' OR prior.last_error_code='delivery_outcome_unknown'
            OR draft.followup_error_safe='delivery_outcome_unknown'
            OR NOT EXISTS(SELECT 1 FROM crm.contacts c JOIN crm.contact_channel_identities identity ON identity.tenant_id=c.tenant_id
              AND identity.contact_id=c.id AND identity.id=prior.recipient_identity_id AND identity.normalized_value=prior.recipient_address
              AND identity.validation_status='valid' AND identity.channel='whatsapp'
              WHERE c.id=draft.reporting_contact_id AND c.tenant_id=draft.tenant_id AND c.whatsapp_consent='granted'
                AND c.whatsapp_opted_out_at IS NULL AND c.lifecycle_status='active') THEN
            RAISE EXCEPTION 'resend requires review or renewed authorization' USING ERRCODE='22023'; END IF;
          IF p_action='retry' AND (prior.status IS DISTINCT FROM 'failed' OR prior.provider_message_id IS NOT NULL
              OR draft.followup_status<>'failed' OR expires<=clock_timestamp()) THEN
            RAISE EXCEPTION 'retry is not safe' USING ERRCODE='22023'; END IF;
          IF p_action='new_request' AND (expires IS NULL OR expires>clock_timestamp() OR prior.status IN ('queued','sending')) THEN
            RAISE EXCEPTION 'new request requires an expired inactive link' USING ERRCODE='22023'; END IF;
          UPDATE service.intake_drafts SET status='collecting',followup_status='queued',followup_error_safe=NULL,
            followup_message_id=CASE WHEN p_action='new_request' THEN NULL ELSE followup_message_id END,updated_at=clock_timestamp()
            WHERE tenant_id=draft.tenant_id AND id=draft.id;
          INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts,priority)
            VALUES(draft.tenant_id,'messaging','field_service.intake_followup','intake_draft',draft.id,
              jsonb_build_object('intakeId',draft.id,'cause','staff_recovery'),
              'intake-staff:'||p_operation::text,4,20);
        ELSE
          UPDATE service.intake_drafts SET followup_closed_at=clock_timestamp(),status='expired',updated_at=clock_timestamp()
            WHERE tenant_id=draft.tenant_id AND id=draft.id;
        END IF;
        INSERT INTO service.intake_staff_actions(tenant_id,operation_id,intake_id,action,actor_id)
          VALUES(draft.tenant_id,p_operation,draft.id,p_action,platform.current_user_id());
      END $$""")
    op.execute(
        "REVOKE ALL ON FUNCTION service.act_on_incomplete_intake(uuid,text,uuid) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION service.act_on_incomplete_intake(uuid,text,uuid) TO platform_web"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION service.can_manage_incomplete_intake()")
    op.execute("DROP FUNCTION service.act_on_incomplete_intake(uuid,text,uuid)")
    op.execute("DROP TABLE service.intake_staff_actions")
