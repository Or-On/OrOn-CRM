"""Durable tenant-scoped publication staging, conservative reviewed binding policies."""

# ruff: noqa: E501
import re

from alembic import op

revision = "a29d5f64ae13"
down_revision = "a18c4e53fd02"
branch_labels = None
depends_on = None


def _execute(script: str) -> None:
    statement = ""
    for index, chunk in enumerate(re.split(r"(\$\$.*?\$\$|'(?:''|[^'])*')", script, flags=re.S)):
        if index % 2:
            statement += chunk
            continue
        fragments = chunk.split(";")
        for fragment in fragments[:-1]:
            statement += fragment
            if statement.strip():
                op.execute(statement)
            statement = ""
        statement += fragments[-1]
    if statement.strip():
        op.execute(statement)


def upgrade() -> None:
    _execute("""
    CREATE TABLE automation.publication_operations (
      id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
      kind text NOT NULL CHECK(kind IN ('agent','retained_voice','canonical')),
      resource_id uuid NOT NULL, candidate_id uuid, candidate_version integer,
      request_hash text NOT NULL CHECK(length(request_hash)=64),
      result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
      created_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(tenant_id,id)
    );
    ALTER TABLE automation.publication_operations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE automation.publication_operations FORCE ROW LEVEL SECURITY;
    CREATE POLICY publication_tenant_scope ON automation.publication_operations
      USING(tenant_id=platform.current_tenant_id())
      WITH CHECK(tenant_id=platform.current_tenant_id());
    GRANT SELECT,INSERT,UPDATE ON automation.publication_operations TO platform_web,platform_voice;
    GRANT SELECT ON automation.publication_operations TO platform_readonly;
    CREATE FUNCTION platform.can_activate_publication() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
      SELECT platform.configuration_actor_authorized(true)
    $$;
    REVOKE ALL ON FUNCTION platform.can_activate_publication() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION platform.can_activate_publication() TO platform_web;
    CREATE FUNCTION platform.validate_publication_binding_policy() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog AS $$
    BEGIN
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.configuration->'processes') p
          WHERE p ? 'bindingPolicy' AND p->>'bindingPolicy' NOT IN ('pinned','follow_published')) THEN
        RAISE EXCEPTION 'unsupported process binding policy' USING ERRCODE='22023';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER publication_binding_policy BEFORE INSERT OR UPDATE ON platform.tenant_configuration_releases
      FOR EACH ROW EXECUTE FUNCTION platform.validate_publication_binding_policy();
    """)


def downgrade() -> None:
    _execute("""
    DROP TRIGGER publication_binding_policy ON platform.tenant_configuration_releases;
    DROP FUNCTION platform.validate_publication_binding_policy();
    DROP TABLE automation.publication_operations;
    DROP FUNCTION IF EXISTS platform.can_activate_publication();
    """)
