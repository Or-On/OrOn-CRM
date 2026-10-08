"""Expose only tenant-scoped menu binding metadata for reviewed reset inventory."""

from alembic import op

revision = "fd480a1fb978"
down_revision = "fc37f90ea867"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "GRANT SELECT(tenant_id,channel_id,enabled,agent_version_id,flow_version_id) "
        "ON platform.whatsapp_opening_menu_configuration TO platform_web"
    )


def downgrade() -> None:
    op.execute(
        "REVOKE SELECT(tenant_id,channel_id,enabled,agent_version_id,flow_version_id) "
        "ON platform.whatsapp_opening_menu_configuration FROM platform_web"
    )
