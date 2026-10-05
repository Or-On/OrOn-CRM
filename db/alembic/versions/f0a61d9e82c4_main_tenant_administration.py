"""Require the main Or-On workspace for cross-tenant administration.

Revision ID: f0a61d9e82c4
Revises: e9c5b8d2a401
"""

from alembic import op

revision = "f0a61d9e82c4"
down_revision = "e9c5b8d2a401"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE FUNCTION platform.tenant_administration_allowed() RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT coalesce(platform.current_tenant_id()=
          '00000000-0000-0000-0000-000000000001'::uuid, false)
          AND EXISTS(SELECT 1 FROM public.users actor
            WHERE actor.id=platform.current_user_id()
              AND actor.is_superuser AND actor.status='active')
          AND EXISTS(SELECT 1 FROM public.tenants tenant
            WHERE tenant.id=platform.current_tenant_id() AND tenant.status='active')
      $$
    """)
    op.execute("REVOKE ALL ON FUNCTION platform.tenant_administration_allowed() FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION platform.tenant_administration_allowed() TO platform_web")
    # Keep each established mutation's validation, audit and active-work guards.
    # No renamed privileged bypass entry point is left callable by application roles.
    op.execute("""
      DO $migration$
      DECLARE signature text; definition text; position integer; guard text;
      BEGIN
        FOREACH signature IN ARRAY ARRAY[
          'platform.create_tenant_with_defaults(text,text,text,text,text,citext)',
          'platform.set_tenant_feature_entitlement(uuid,boolean,text)',
          'platform.delete_tenant_for_administrator(uuid,text)'
        ] LOOP
          definition:=pg_get_functiondef(signature::regprocedure);
          position:=strpos(definition,'BEGIN');
          IF position=0 THEN RAISE EXCEPTION 'tenant administration guard target changed'; END IF;
          guard:=E'\n IF NOT platform.tenant_administration_allowed() THEN\n'
            ||E' RAISE EXCEPTION ''main workspace administrator required'' '
            ||E'USING ERRCODE=''42501'';\n END IF;\n';
          IF signature='platform.delete_tenant_for_administrator(uuid,text)' THEN
            guard:=guard||E' IF p_tenant_id=''00000000-0000-0000-0000-000000000001''::uuid THEN\n'
              ||E' RAISE EXCEPTION ''main management workspace cannot be deleted'' '
              ||E'USING ERRCODE=''22023'';\n END IF;\n';
          END IF;
          EXECUTE overlay(definition placing 'BEGIN'||guard from position for 5);
        END LOOP;
        FOREACH signature IN ARRAY ARRAY[
          'platform.list_tenants_for_administrator()',
          'platform.list_tenant_field_service_entitlements_for_administrator()'
        ] LOOP
          definition:=pg_get_functiondef(signature::regprocedure);
          IF (length(definition)-length(replace(definition,
              'WHERE tenant.status <> ''deleted''','')))
              /length('WHERE tenant.status <> ''deleted''')<>1 THEN
            RAISE EXCEPTION 'tenant administration directory target changed';
          END IF;
          EXECUTE replace(definition,'WHERE tenant.status <> ''deleted''',
            'WHERE tenant.status <> ''deleted'' AND platform.tenant_administration_allowed()');
        END LOOP;
      END $migration$
    """)


def downgrade() -> None:
    # Retain the stricter authorization boundary during an application rollback.
    pass
