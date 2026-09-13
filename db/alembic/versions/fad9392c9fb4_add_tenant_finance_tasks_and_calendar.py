"""add tenant finance tasks and calendar

Revision ID: fad9392c9fb4
Revises: ea600fafe463
Create Date: 2026-09-11 09:47:47.153047
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "fad9392c9fb4"
down_revision: str | None = "ea600fafe463"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # This revision owns the namespace; fail loudly if an unrelated schema with
    # the same name exists instead of later dropping someone else's objects.
    op.execute('CREATE SCHEMA "finance"')
    op.execute('REVOKE ALL ON SCHEMA "finance" FROM PUBLIC')

    op.create_table(
        "expenses",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("vendor", sa.Text(), nullable=True),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="recorded"),
        sa.Column("source_kind", sa.Text(), nullable=False, server_default="manual"),
        sa.Column("source_reference", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("incurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.CheckConstraint("char_length(btrim(title)) BETWEEN 1 AND 240", name="ck_expenses_title"),
        sa.CheckConstraint(
            "vendor IS NULL OR char_length(btrim(vendor)) BETWEEN 1 AND 240",
            name="ck_expenses_vendor",
        ),
        sa.CheckConstraint(
            "char_length(btrim(category)) BETWEEN 1 AND 80", name="ck_expenses_category"
        ),
        sa.CheckConstraint("amount > 0", name="ck_expenses_amount_positive"),
        sa.CheckConstraint("currency ~ '^[A-Z]{3}$'", name="ck_expenses_currency_iso"),
        sa.CheckConstraint("status IN ('pending', 'recorded', 'void')", name="ck_expenses_status"),
        sa.CheckConstraint(
            "source_kind IN ('manual', 'provider_invoice')", name="ck_expenses_source_kind"
        ),
        sa.CheckConstraint(
            "source_reference IS NULL OR char_length(btrim(source_reference)) BETWEEN 1 AND 500",
            name="ck_expenses_source_reference",
        ),
        sa.CheckConstraint(
            "notes IS NULL OR char_length(notes) <= 10000", name="ck_expenses_notes"
        ),
        schema="finance",
    )
    op.create_index(
        "ix_expenses_tenant_incurred",
        "expenses",
        ["tenant_id", sa.text("incurred_at DESC"), sa.text("id DESC")],
        schema="finance",
    )
    op.create_index(
        "ix_expenses_tenant_status_incurred",
        "expenses",
        ["tenant_id", "status", sa.text("incurred_at DESC"), sa.text("id DESC")],
        schema="finance",
    )
    op.create_index(
        "uq_expenses_tenant_source_reference",
        "expenses",
        ["tenant_id", "source_kind", "source_reference"],
        unique=True,
        schema="finance",
        postgresql_where=sa.text("source_reference IS NOT NULL"),
    )

    op.create_table(
        "tasks",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("assignee_user_id", sa.UUID(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="todo"),
        sa.Column("priority", sa.Text(), nullable=False, server_default="medium"),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["assignee_user_id", "tenant_id"],
            ["memberships.user_id", "memberships.tenant_id"],
            name="fk_tasks_assignee_membership",
            ondelete="SET NULL (assignee_user_id)",
        ),
        sa.CheckConstraint("char_length(btrim(title)) BETWEEN 1 AND 240", name="ck_tasks_title"),
        sa.CheckConstraint(
            "description IS NULL OR char_length(description) <= 20000",
            name="ck_tasks_description",
        ),
        sa.CheckConstraint(
            "status IN ('todo', 'in_progress', 'completed', 'cancelled')",
            name="ck_tasks_status",
        ),
        sa.CheckConstraint(
            "priority IN ('low', 'medium', 'high', 'urgent')", name="ck_tasks_priority"
        ),
        sa.CheckConstraint(
            "(status = 'completed' AND completed_at IS NOT NULL) "
            "OR (status <> 'completed' AND completed_at IS NULL)",
            name="ck_tasks_completion_state",
        ),
        schema="crm",
    )
    op.create_index(
        "ix_tasks_tenant_status_due",
        "tasks",
        ["tenant_id", "status", sa.text("due_at ASC NULLS LAST"), sa.text("id ASC")],
        schema="crm",
    )
    op.create_index(
        "ix_tasks_tenant_assignee_status",
        "tasks",
        ["tenant_id", "assignee_user_id", "status", sa.text("updated_at DESC")],
        schema="crm",
    )

    op.create_table(
        "calendar_events",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("organizer_user_id", sa.UUID(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("location", sa.Text(), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("all_day", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("timezone", sa.Text(), nullable=False, server_default="UTC"),
        sa.Column("status", sa.Text(), nullable=False, server_default="confirmed"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["organizer_user_id", "tenant_id"],
            ["memberships.user_id", "memberships.tenant_id"],
            name="fk_calendar_organizer_membership",
            ondelete="SET NULL (organizer_user_id)",
        ),
        sa.CheckConstraint("char_length(btrim(title)) BETWEEN 1 AND 240", name="ck_calendar_title"),
        sa.CheckConstraint(
            "description IS NULL OR char_length(description) <= 20000",
            name="ck_calendar_description",
        ),
        sa.CheckConstraint(
            "location IS NULL OR char_length(btrim(location)) BETWEEN 1 AND 500",
            name="ck_calendar_location",
        ),
        sa.CheckConstraint("ends_at > starts_at", name="ck_calendar_time_range"),
        sa.CheckConstraint(
            "char_length(btrim(timezone)) BETWEEN 1 AND 100", name="ck_calendar_timezone"
        ),
        sa.CheckConstraint(
            "status IN ('confirmed', 'tentative', 'cancelled')", name="ck_calendar_status"
        ),
        schema="crm",
    )
    op.create_index(
        "ix_calendar_events_tenant_range",
        "calendar_events",
        ["tenant_id", "starts_at", "ends_at", "id"],
        schema="crm",
    )
    op.create_index(
        "ix_calendar_events_tenant_status_start",
        "calendar_events",
        ["tenant_id", "status", "starts_at", "id"],
        schema="crm",
    )

    tenant_tables = (
        ("finance", "expenses"),
        ("crm", "tasks"),
        ("crm", "calendar_events"),
    )
    for schema, table in tenant_tables:
        qualified = f'{schema}."{table}"'
        op.execute(sa.text(f"ALTER TABLE {qualified} ENABLE ROW LEVEL SECURITY"))
        op.execute(sa.text(f"ALTER TABLE {qualified} FORCE ROW LEVEL SECURITY"))
        op.execute(
            sa.text(
                f"CREATE POLICY {table}_tenant_isolation ON {qualified} "
                "USING (tenant_id = platform.current_tenant_id()) "
                "WITH CHECK (tenant_id = platform.current_tenant_id())"
            )
        )

    op.execute("GRANT USAGE ON SCHEMA finance TO platform_web, platform_readonly")
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON finance.expenses TO platform_web")
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON crm.tasks TO platform_web")
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON crm.calendar_events TO platform_web")
    op.execute("GRANT SELECT ON finance.expenses TO platform_readonly")
    op.execute("GRANT SELECT ON crm.tasks, crm.calendar_events TO platform_readonly")


def downgrade() -> None:
    op.drop_table("calendar_events", schema="crm")
    op.drop_table("tasks", schema="crm")
    op.drop_table("expenses", schema="finance")
    op.execute('DROP SCHEMA IF EXISTS "finance"')
