"""Reject new duplicate tenant URL slugs without rewriting existing records."""

from alembic import op
from sqlalchemy.schema import DDL

revision = "f82a407bfd6c"
down_revision = "f71f396aec5b"
branch_labels = None
depends_on = None

SLUG_GUARD_SQL = """
CREATE FUNCTION platform.guard_tenant_slug_uniqueness()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
  -- Legacy duplicates remain intact; unrelated/unchanged updates still work.
  IF TG_OP = 'UPDATE' AND NEW.slug IS NOT DISTINCT FROM OLD.slug THEN
    -- The caller cannot disable protection or activate conflicting legacy rows.
    NEW.slug_guarded := OLD.slug_guarded;
    RETURN NEW;
  END IF;
  NEW.slug_guarded := true;
  -- The API already normalizes its slug. Lock normalization only broadens
  -- serialization; exact comparison retains historical case semantics.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tenant.slug.guard.v1:' ||
      pg_catalog.lower(pg_catalog.btrim(NEW.slug)), 0));
  IF EXISTS (
    SELECT 1 FROM public.tenants existing
    WHERE existing.slug = NEW.slug AND existing.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'Tenant URL slug already exists' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;

"""


def upgrade() -> None:
    # Existing duplicates remain grandfathered; future identities are unique
    # through PostgreSQL's index, including REPEATABLE READ snapshots.
    op.execute("ALTER TABLE public.tenants ADD COLUMN slug_guarded boolean NOT NULL DEFAULT false")
    op.execute("ALTER TABLE public.tenants ALTER COLUMN slug_guarded SET DEFAULT true")
    op.execute(
        "CREATE UNIQUE INDEX uq_tenants_guarded_slug ON public.tenants(slug) WHERE slug_guarded"
    )
    op.execute(DDL(SLUG_GUARD_SQL.replace("%", "%%")))
    op.execute("REVOKE ALL ON FUNCTION platform.guard_tenant_slug_uniqueness() FROM PUBLIC")
    op.execute(
        "CREATE TRIGGER trg_tenant_slug_uniqueness "
        "BEFORE INSERT OR UPDATE OF slug, slug_guarded ON public.tenants "
        "FOR EACH ROW EXECUTE FUNCTION platform.guard_tenant_slug_uniqueness()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER trg_tenant_slug_uniqueness ON public.tenants")
    op.execute("DROP FUNCTION platform.guard_tenant_slug_uniqueness()")
    op.execute("DROP INDEX public.uq_tenants_guarded_slug")
    op.execute("ALTER TABLE public.tenants DROP COLUMN slug_guarded")
