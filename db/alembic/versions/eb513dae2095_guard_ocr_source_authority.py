"""Authorize OCR against its stored uploader and current canonical case scope.

Revision ID: eb513dae2095
Revises: ea402c9d1f84
"""

from alembic import op

revision = "eb513dae2095"
down_revision = "ea402c9d1f84"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE FUNCTION service.ocr_origin_actor_authorized(p_attachment uuid,p_actor uuid)
      RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
      SET search_path=pg_catalog AS $$
      DECLARE v_case uuid; v_role text; v_super boolean; v_technician uuid;
      BEGIN
        IF p_actor IS NULL OR platform.current_tenant_id() IS NULL THEN RETURN false; END IF;
        PERFORM 1 FROM public.tenants t
          WHERE t.id=platform.current_tenant_id() AND t.status='active' FOR SHARE;
        IF NOT FOUND THEN RETURN false; END IF;
        SELECT u.is_superuser INTO v_super FROM public.users u
          WHERE u.id=p_actor AND u.status='active' FOR SHARE;
        IF NOT FOUND THEN RETURN false; END IF;
        SELECT a.case_id INTO v_case FROM service.report_attachments a
          JOIN service.cases c ON c.id=a.case_id AND c.tenant_id=a.tenant_id
          JOIN objects.object_metadata o ON o.id=a.object_id AND o.tenant_id=a.tenant_id
          WHERE a.id=p_attachment AND a.tenant_id=platform.current_tenant_id()
            AND a.created_by_user_id=p_actor AND o.deleted_at IS NULL
          FOR SHARE OF a,c,o;
        IF NOT FOUND THEN RETURN false; END IF;
        SELECT m.role INTO v_role FROM public.memberships m
          WHERE m.tenant_id=platform.current_tenant_id() AND m.user_id=p_actor FOR SHARE;
        IF v_super THEN RETURN true; END IF;
        IF v_role IN ('owner','admin','editor','agent') THEN RETURN true; END IF;
        IF v_role IS DISTINCT FROM 'technician' THEN RETURN false; END IF;
        -- Only an individually linked technician has durable uploader identity.
        -- Shared-session identity was never persisted in this attachment/job.
        SELECT t.id INTO v_technician FROM service.technicians t
          WHERE t.tenant_id=platform.current_tenant_id()
            AND t.linked_user_id=p_actor AND t.active FOR SHARE;
        IF NOT FOUND THEN RETURN false; END IF;
        PERFORM 1 FROM service.cases c
          WHERE c.tenant_id=platform.current_tenant_id() AND c.id=v_case
            AND c.assigned_technician_id=v_technician FOR SHARE;
        IF FOUND THEN RETURN true; END IF;
        PERFORM 1 FROM service.appointments a
          WHERE a.tenant_id=platform.current_tenant_id() AND a.case_id=v_case
            AND a.technician_id=v_technician AND a.status<>'cancelled' FOR SHARE;
        IF FOUND THEN RETURN true; END IF;
        PERFORM 1 FROM service.visits v
          WHERE v.tenant_id=platform.current_tenant_id() AND v.case_id=v_case
            AND v.technician_id=v_technician AND v.status<>'cancelled' FOR SHARE;
        RETURN FOUND;
      END $$
    """)
    op.execute("REVOKE ALL ON FUNCTION service.ocr_origin_actor_authorized(uuid,uuid) FROM PUBLIC")
    op.execute("""
      GRANT EXECUTE ON FUNCTION service.ocr_origin_actor_authorized(uuid,uuid)
      TO platform_messaging
    """)


def downgrade() -> None:
    op.execute("DROP FUNCTION service.ocr_origin_actor_authorized(uuid,uuid)")
