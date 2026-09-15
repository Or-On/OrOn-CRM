"""complete field-service lifecycle controls

Revision ID: b72c5f0e4d91
Revises: a26f09c4d13e
Create Date: 2026-09-15 10:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "b72c5f0e4d91"
down_revision: str | None = "a26f09c4d13e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE crm.service_locations ADD COLUMN archived_at timestamptz")
    op.execute("""
        CREATE INDEX ix_service_locations_active_customer
        ON crm.service_locations(tenant_id, customer_contact_id, lower(name), id)
        WHERE archived_at IS NULL
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_active_technician_linked_user
        ON service.technicians(tenant_id, linked_user_id)
        WHERE linked_user_id IS NOT NULL AND active
    """)
    op.execute("""
        CREATE FUNCTION service.validate_technician_user_link()
        RETURNS trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        BEGIN
          IF NEW.active AND NEW.linked_user_id IS NOT NULL AND NOT EXISTS (
            SELECT 1
            FROM public.memberships membership
            JOIN public.users account ON account.id=membership.user_id
            JOIN public.tenants tenant ON tenant.id=membership.tenant_id
            WHERE membership.tenant_id=NEW.tenant_id
              AND membership.user_id=NEW.linked_user_id
              AND membership.role='technician'
              AND account.status='active'
              AND tenant.status='active'
          ) THEN
            RAISE EXCEPTION
              'linked technician user must be an active technician member of the tenant'
              USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END
        $$
    """)
    op.execute("REVOKE ALL ON FUNCTION service.validate_technician_user_link() FROM PUBLIC")
    op.execute("""
        CREATE TRIGGER trg_validate_technician_user_link
        BEFORE INSERT OR UPDATE OF tenant_id, linked_user_id, active
        ON service.technicians
        FOR EACH ROW EXECUTE FUNCTION service.validate_technician_user_link()
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER trg_validate_technician_user_link ON service.technicians")
    op.execute("DROP FUNCTION service.validate_technician_user_link()")
    op.execute("DROP INDEX service.uq_active_technician_linked_user")
    op.execute("DROP INDEX crm.ix_service_locations_active_customer")
    op.execute("ALTER TABLE crm.service_locations DROP COLUMN archived_at")
