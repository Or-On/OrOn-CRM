"""Preserve usage per actual model when a call uses the bounded fallback."""

from alembic import op

revision = "f7e2b4c95312"
down_revision = "f6d1a3b84201"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE public.sessions ADD COLUMN llm_usage_by_model jsonb NOT NULL "
        "DEFAULT '{}'::jsonb CHECK(jsonb_typeof(llm_usage_by_model)='object')"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE public.sessions DROP COLUMN llm_usage_by_model")
