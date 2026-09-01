"""users, identities and memberships

Revision ID: a41d2f6c2925
Revises: 8aa960fd77ec
Create Date: 2026-08-04 00:04:18.930113

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

from db.alembic.oron_migration_compat import DbRole

# revision identifiers, used by Alembic.
revision: str = "a41d2f6c2925"
down_revision: str | Sequence[str] | None = "8aa960fd77ec"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DML = "SELECT, INSERT, UPDATE, DELETE"


def _tenancy_role() -> str:
    """Prod grants the role itself; the xdist harness injects a per-worker name.
    Same indirection as 0011 — without it `pytest -n auto` grants a role that does
    not exist in that worker's database."""
    return context.config.attributes.get("tenancy_role", str(DbRole.TENANCY))


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    ]


def upgrade() -> None:
    # citext is a trusted extension since PG13, so this needs no superuser.
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")

    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", postgresql.CITEXT(), nullable=False),
        sa.Column("is_superuser", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        *_timestamps(),
    )
    # Unique *index*, not a unique constraint: `Field(unique=True, index=True)`
    # renders one unique index, and a constraint here would drift from the model.
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    # Cascades throughout: removing someone must not leave a binding behind that a
    # recreated Firebase account could later collide with.
    op.create_table(
        "user_identities",
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("firebase_uid", sa.String(), nullable=False),
        sa.Column(
            "bound_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        *_timestamps(),
    )
    op.create_index(
        "ix_user_identities_firebase_uid", "user_identities", ["firebase_uid"], unique=True
    )

    op.create_table(
        "memberships",
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "tenant_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("role", sa.String(), nullable=False),
        *_timestamps(),
    )

    # 0011 sets no ALTER DEFAULT PRIVILEGES on purpose: a new table must name the
    # role that gets it, rather than being handed to both by omission.
    role = _tenancy_role()
    for table in ("users", "user_identities", "memberships"):
        op.execute(f'GRANT {DML} ON {table} TO "{role}"')


def downgrade() -> None:
    # citext stays: dropping it would break anything else that has adopted it.
    op.drop_table("memberships")
    op.drop_index("ix_user_identities_firebase_uid", table_name="user_identities")
    op.drop_table("user_identities")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
