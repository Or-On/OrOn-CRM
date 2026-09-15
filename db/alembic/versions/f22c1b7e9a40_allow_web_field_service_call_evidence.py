"""allow web field service call evidence reads

Revision ID: f22c1b7e9a40
Revises: d4e15a9c7b02
Create Date: 2026-09-15 10:15:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f22c1b7e9a40"
down_revision: str | None = "d4e15a9c7b02"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Field-service case linking and dossiers need non-sensitive call metadata,
    # not phone-number ciphertext, provider identifiers, or raw event payloads.
    # The sessions table enforces tenant isolation with FORCE ROW LEVEL SECURITY.
    op.execute(
        "GRANT SELECT (direction, ended_at, recording_object_id, "
        "transcript_object_id) ON public.sessions TO platform_web"
    )
    op.execute(
        sa.text("""
        CREATE FUNCTION service.current_tenant_voice_admission_conversations(
          p_voice_session_id uuid
        )
        RETURNS TABLE (
          voice_session_id uuid,
          source_conversation_id uuid
        )
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT DISTINCT
            event.session_id AS voice_session_id,
            CASE
              WHEN event.payload->>'source_conversation_id' ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (event.payload->>'source_conversation_id')::uuid
              ELSE NULL
            END AS source_conversation_id
          FROM public.session_events AS event
          WHERE event.tenant_id = platform.current_tenant_id()
            AND event.session_id = p_voice_session_id
            AND event.event_type = 'voice.call.admission.v1'
            AND coalesce(event.payload->>'source_conversation_id', '') ~*
              '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        $$
        """)
    )
    op.execute(
        "REVOKE ALL ON FUNCTION "
        "service.current_tenant_voice_admission_conversations(uuid) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        "service.current_tenant_voice_admission_conversations(uuid) TO platform_web"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION service.current_tenant_voice_admission_conversations(uuid)")
    op.execute(
        "REVOKE SELECT (direction, ended_at, recording_object_id, "
        "transcript_object_id) ON public.sessions FROM platform_web"
    )
