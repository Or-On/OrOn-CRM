"""Published lead contracts cannot be rewritten underneath pinned conversations."""

from alembic import op

revision = "fc37f90ea867"
down_revision = "fb26e8fd9756"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE FUNCTION crm.protect_published_lead_schema() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
        IF OLD.published_at IS NOT NULL AND
          (to_jsonb(NEW)-'created_by_user_id') IS DISTINCT FROM
          (to_jsonb(OLD)-'created_by_user_id') THEN
          RAISE EXCEPTION 'published lead schema is immutable; create a new version'
            USING ERRCODE='55000';
        END IF;
        RETURN NEW;
      END $$""")
    op.execute("REVOKE ALL ON FUNCTION crm.protect_published_lead_schema() FROM PUBLIC")
    op.execute("""
      CREATE TRIGGER published_lead_schema BEFORE UPDATE ON crm.lead_field_schemas
        FOR EACH ROW EXECUTE FUNCTION crm.protect_published_lead_schema()""")


def downgrade() -> None:
    op.execute("DROP TRIGGER published_lead_schema ON crm.lead_field_schemas")
    op.execute("DROP FUNCTION crm.protect_published_lead_schema()")
