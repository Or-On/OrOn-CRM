"""Wake messaging workers with a content-free committed job hint.

Revision ID: ee8460d153c8
Revises: ed735fc042b7
"""

from alembic import op

revision = "ee8460d153c8"
down_revision = "ed735fc042b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE FUNCTION ops.notify_messaging_job_available() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN
        IF NEW.queue IN ('messaging','field_service')
           AND NEW.status IN ('queued','retry') THEN
          PERFORM pg_catalog.pg_notify('oron_messaging_jobs','');
        END IF;
        RETURN NEW;
      END $$
    """)
    op.execute("REVOKE ALL ON FUNCTION ops.notify_messaging_job_available() FROM PUBLIC")
    op.execute("""
      CREATE TRIGGER notify_messaging_job_available
      AFTER INSERT OR UPDATE OF status,available_at,queue,priority ON ops.jobs
      FOR EACH ROW EXECUTE FUNCTION ops.notify_messaging_job_available()
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER notify_messaging_job_available ON ops.jobs")
    op.execute("DROP FUNCTION ops.notify_messaging_job_available()")
