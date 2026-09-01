"""campaigns and campaign_contacts

Dial a list through one flow. Both tables are call data, so they belong to the
sessions role and sit under the same kind of RLS policy as `sessions` — a plain
`tenant_id = GUC`, with none of the packaged-catalog exception `flows` needs:
nobody owns a shared campaign.

Revision ID: 46a2cce29f18
Revises: 0011
Create Date: 2026-07-29
"""

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

from db.alembic.oron_migration_compat import DbRole

revision = "46a2cce29f18"
down_revision = "8eda5976c920"
branch_labels = None
depends_on = None

TABLES = ("campaigns", "campaign_contacts")

POLICY = (
    "USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid) "
    "WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)"
)

CAMPAIGN_STATUS = ("draft", "running", "paused", "done")
CONTACT_STATUS = ("pending", "calling", "called", "failed")


def _sessions_role() -> str:
    """See 0011 — the real role in prod, a per-worker name under xdist."""
    return context.config.attributes.get("sessions_role", str(DbRole.SESSIONS))


def _existing(name: str) -> postgresql.ENUM:
    """Reference a type the migration already created; create_type=False stops
    the table DDL trying to create it a second time."""
    return postgresql.ENUM(name=name, create_type=False)


def upgrade() -> None:
    bind = op.get_bind()
    postgresql.ENUM(*CAMPAIGN_STATUS, name="campaignstatus").create(bind, checkfirst=True)
    postgresql.ENUM(*CONTACT_STATUS, name="contactstatus").create(bind, checkfirst=True)

    op.create_table(
        "campaigns",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("tenant_id", sa.Uuid(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("flow_id", sa.Uuid(), nullable=False),
        sa.Column("status", _existing("campaignstatus"), nullable=False, server_default="draft"),
        # Defaults to one: a dialer that fans out by default is a dialer that
        # fans out by accident.
        sa.Column("max_concurrent", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        # Concurrency is a safety limit, so the database holds both ends of it
        # rather than trusting every caller to.
        sa.CheckConstraint(
            "max_concurrent >= 1 AND max_concurrent <= 20", name="ck_campaigns_max_concurrent"
        ),
    )
    op.create_index("ix_campaigns_tenant_id", "campaigns", ["tenant_id"])

    op.create_table(
        "campaign_contacts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("tenant_id", sa.Uuid(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column(
            "campaign_id",
            sa.Uuid(),
            sa.ForeignKey("campaigns.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Ciphertext, like sessions.to_number — never the number itself.
        # Dial order = file order; created_at is transaction time and ties.
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("phone_number", sa.String(), nullable=False),
        sa.Column("phone_bidx", sa.String(), nullable=False),
        sa.Column(
            "data", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column("status", _existing("contactstatus"), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("session_id", sa.Uuid(), nullable=True),
        sa.Column("last_error", sa.String(), nullable=True),
        sa.Column("called_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        # One row per number per campaign, enforced here rather than by the
        # importer remembering to check. Duplicates in an exported spreadsheet
        # are normal; dialling the same person twice is not.
        sa.UniqueConstraint("campaign_id", "phone_bidx", name="uq_campaign_contact_number"),
    )
    op.create_index("ix_campaign_contacts_tenant_id", "campaign_contacts", ["tenant_id"])
    op.create_index("ix_campaign_contacts_phone_bidx", "campaign_contacts", ["phone_bidx"])
    # The claim query: pending rows of one campaign, oldest first.
    op.create_index(
        "ix_campaign_contacts_claim", "campaign_contacts", ["campaign_id", "status", "position"]
    )

    role = _sessions_role()
    for table in TABLES:
        op.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO "{role}"')
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(f"CREATE POLICY tenant_iso ON {table} {POLICY}")


def downgrade() -> None:
    for table in TABLES:
        op.execute(f"DROP POLICY IF EXISTS tenant_iso ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    op.drop_table("campaign_contacts")
    op.drop_table("campaigns")
    bind = op.get_bind()
    postgresql.ENUM(name="contactstatus").drop(bind, checkfirst=True)
    postgresql.ENUM(name="campaignstatus").drop(bind, checkfirst=True)
