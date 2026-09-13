"""add durable active voice pause and resume control

Revision ID: eb626a89c3a8
Revises: 17f57105f1a9
Create Date: 2026-09-12 22:44:22.783370
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "eb626a89c3a8"
down_revision: str | None = "17f57105f1a9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "voice_session_controls",
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), primary_key=True),
        sa.Column("epoch", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("desired_mode", sa.Text(), nullable=False, server_default="ai"),
        sa.Column("command_id", sa.UUID()),
        sa.Column("requested_by_user_id", sa.UUID()),
        sa.Column("acknowledged_epoch", sa.BigInteger()),
        sa.Column("worker_mode", sa.Text()),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True)),
        sa.ForeignKeyConstraint(
            ["tenant_id", "session_id"],
            ["sessions.tenant_id", "sessions.session_id"],
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("tenant_id", "session_id"),
        sa.CheckConstraint("epoch>=0 AND desired_mode IN ('ai','paused')"),
        sa.CheckConstraint("acknowledged_epoch IS NULL OR acknowledged_epoch BETWEEN 0 AND epoch"),
        sa.CheckConstraint("worker_mode IS NULL OR worker_mode IN ('ai','paused')"),
    )
    op.create_table(
        "voice_session_control_commands",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("mode", sa.Text(), nullable=False),
        sa.Column("expected_epoch", sa.BigInteger(), nullable=False),
        sa.Column("assigned_epoch", sa.BigInteger(), nullable=False),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True)),
        sa.Column("worker_mode", sa.Text()),
        sa.Column(
            "requested_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "session_id"],
            ["voice_session_controls.tenant_id", "voice_session_controls.session_id"],
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("tenant_id", "idempotency_key"),
        sa.UniqueConstraint("tenant_id", "session_id", "assigned_epoch"),
        sa.CheckConstraint("mode IN ('ai','paused') AND expected_epoch>=0 AND assigned_epoch>0"),
        sa.CheckConstraint("idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'"),
        sa.CheckConstraint("worker_mode IS NULL OR worker_mode IN ('ai','paused')"),
    )
    for table in ("voice_session_controls", "voice_session_control_commands"):
        op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE public.{table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY tenant_scope ON public.{table} "
            "USING (tenant_id=platform.current_tenant_id()) "
            "WITH CHECK (tenant_id=platform.current_tenant_id())"
        )
        op.execute(f"GRANT SELECT ON public.{table} TO platform_voice")
    # Workers can initialize default state and acknowledge it, never change the
    # desired mode, actor, command, or epoch with direct SQL.
    op.execute(
        "GRANT INSERT(tenant_id,session_id) ON public.voice_session_controls TO platform_voice"
    )
    op.execute("""
        GRANT UPDATE(acknowledged_epoch,worker_mode,acknowledged_at)
        ON public.voice_session_controls TO platform_voice
    """)
    op.execute("""
        GRANT UPDATE(acknowledged_at,worker_mode)
        ON public.voice_session_control_commands TO platform_voice
    """)
    op.execute("""
        CREATE FUNCTION platform.voice_control_actor_allowed(p_actor uuid,p_write boolean)
        RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
          SELECT EXISTS (
            SELECT 1 FROM public.users u JOIN public.tenants t
              ON t.id=platform.current_tenant_id()
            LEFT JOIN public.memberships m ON m.user_id=u.id AND m.tenant_id=t.id
            WHERE u.id=p_actor AND u.status='active' AND t.status='active'
              AND (u.is_superuser OR m.role IN ('owner','admin','agent')
                   OR (NOT p_write AND m.role='viewer'))
          )
        $$
    """)
    op.execute("""
        CREATE FUNCTION platform.request_voice_control(
          p_session uuid,p_mode text,p_expected bigint,p_key text
        ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE
          v_tenant uuid := platform.current_tenant_id();
          v_actor uuid := platform.current_user_id();
          v_prior public.voice_session_control_commands%ROWTYPE;
          v_control public.voice_session_controls%ROWTYPE;
          v_command uuid;
        BEGIN
          IF NOT platform.voice_control_actor_allowed(v_actor,true) THEN
            RAISE EXCEPTION 'voice control operator is unavailable' USING ERRCODE='42501';
          END IF;
          IF p_mode NOT IN ('ai','paused') OR p_expected<0 OR
             p_key !~ '^[A-Za-z0-9._:-]{8,128}$' THEN
            RAISE EXCEPTION 'invalid voice control command' USING ERRCODE='22023';
          END IF;
          PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant::text||':'||p_key,0));
          SELECT * INTO v_prior FROM public.voice_session_control_commands
            WHERE tenant_id=v_tenant AND idempotency_key=p_key;
          IF FOUND THEN
            IF v_prior.session_id<>p_session OR v_prior.mode<>p_mode OR
               v_prior.expected_epoch<>p_expected OR v_prior.actor_id<>v_actor THEN
              RAISE EXCEPTION 'voice control idempotency conflict' USING ERRCODE='23505';
            END IF;
            RETURN;
          END IF;
          PERFORM 1 FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session
            AND status='started' AND ended_at IS NULL AND provider='livekit' FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'active voice session unavailable' USING ERRCODE='P0002';
          END IF;
          INSERT INTO public.voice_session_controls(tenant_id,session_id)
            VALUES(v_tenant,p_session) ON CONFLICT(session_id) DO NOTHING;
          SELECT * INTO v_control FROM public.voice_session_controls
            WHERE tenant_id=v_tenant AND session_id=p_session FOR UPDATE;
          IF v_control.epoch<>p_expected THEN
            RAISE EXCEPTION 'voice control epoch conflict' USING ERRCODE='23505';
          END IF;
          INSERT INTO public.voice_session_control_commands
            (tenant_id,session_id,actor_id,idempotency_key,mode,expected_epoch,assigned_epoch)
            VALUES(v_tenant,p_session,v_actor,p_key,p_mode,p_expected,p_expected+1)
            RETURNING id INTO v_command;
          UPDATE public.voice_session_controls SET epoch=p_expected+1,desired_mode=p_mode,
            command_id=v_command,requested_by_user_id=v_actor
            WHERE tenant_id=v_tenant AND session_id=p_session;
        END $$
    """)
    for signature in (
        "platform.voice_control_actor_allowed(uuid,boolean)",
        "platform.request_voice_control(uuid,text,bigint,text)",
    ):
        op.execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
        op.execute(f"GRANT EXECUTE ON FUNCTION {signature} TO platform_voice")


def downgrade() -> None:
    op.execute("""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM public.voice_session_control_commands) THEN
            RAISE EXCEPTION 'voice control audit requires backup and forward recovery'
              USING ERRCODE='55000';
          END IF;
        END $$
    """)
    op.execute("DROP FUNCTION platform.request_voice_control(uuid,text,bigint,text)")
    op.execute("DROP FUNCTION platform.voice_control_actor_allowed(uuid,boolean)")
    op.drop_table("voice_session_control_commands")
    op.drop_table("voice_session_controls")
