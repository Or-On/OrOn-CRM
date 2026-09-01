"""split the one app role into least-privilege sessions and tenancy roles

Revision ID: 0011
Revises: 0010
Create Date: 2026-07-26
"""

from alembic import context, op

from db.alembic.oron_migration_compat import DbRole

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

DML = "SELECT, INSERT, UPDATE, DELETE"

# What each runtime role may touch, and nothing more. `sessions`/`flows` are
# call data under RLS; the rest are the control plane, including the credential
# table. Deliberately no ALTER DEFAULT PRIVILEGES: a new table must name the
# role that gets it, rather than being handed to both by omission.
GRANTS = {
    DbRole.SESSIONS: ("sessions", "flows"),
    DbRole.TENANCY: ("tenants", "phone_numbers", "api_keys"),
}


def _role(role: DbRole) -> str:
    """The name to grant. The role itself in prod; the test harness injects a
    per-worker name (`<role>_<worker>`) via `config.attributes`, since the role
    is cluster-wide while each xdist worker owns only its own database."""
    return context.config.attributes.get(f"{role.name.lower()}_role", str(role))


def upgrade() -> None:
    for role, tables in GRANTS.items():
        name = _role(role)
        # Password is set out-of-band (GCP Secret Manager), never in a migration.
        op.execute(
            f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='{name}') "
            f'THEN CREATE ROLE "{name}" LOGIN; END IF; END $$;'
        )
        op.execute(f'GRANT USAGE ON SCHEMA public TO "{name}"')
        for table in tables:
            op.execute(f'GRANT {DML} ON {table} TO "{name}"')

    # `oron_app` is left in place with the grants 0002 gave it: revoking here
    # would cut off the running deployment at migration time, before the
    # CONTROL_DATABASE_URL/DATABASE_URL swap. Decommission it after the deploy —
    # see deploy/livekit/README.md.


def downgrade() -> None:
    for role in GRANTS:
        name = _role(role)
        op.execute(f'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "{name}"')
        op.execute(f'REVOKE ALL ON SCHEMA public FROM "{name}"')
        op.execute(f'DROP ROLE IF EXISTS "{name}"')
