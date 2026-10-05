"""Offer a fresh opening menu after AI resumes or an inbox conversation reopens."""

from alembic import op

revision = "c8e71b4a209d"
down_revision = "b162a7e4d903"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      ALTER TABLE platform.whatsapp_opening_menu_state
        ADD COLUMN inbox_reopened_at timestamptz;
    """)
    op.execute("""
      UPDATE platform.whatsapp_opening_menu_state state
        SET inbox_reopened_at=conversation.inbox_reopened_at
        FROM messaging.conversations conversation
        WHERE conversation.tenant_id=state.tenant_id
          AND conversation.id=state.conversation_id;
    """)
    # Keep the existing authorization, immutable physical receipts and duplicate
    # protection. Only a canonical ownership/reopen boundary starts a new menu.
    op.execute("""
      DO $migration$
      DECLARE definition text; original text; replacement text;
      BEGIN
        definition:=pg_get_functiondef(
          'platform.opening_menu_scope(uuid,text,uuid)'::regprocedure);
        original:='''channelId'',ch.id,''ownershipEpoch'',c.ownership_epoch';
        replacement:='''channelId'',ch.id,''inboxReopenedAt'',c.inbox_reopened_at,'
          ||'''ownershipEpoch'',c.ownership_epoch';
        IF (length(definition)-length(replace(definition,original,'')))
            /length(original)<>1 THEN
          RAISE EXCEPTION 'opening menu reopen scope patch target changed';
        END IF;
        EXECUTE replace(definition,original,replacement);

        definition:=pg_get_functiondef(
          'platform.prepare_opening_menu(uuid,text,uuid)'::regprocedure);
        original:='IF s.ownership_epoch IS DISTINCT FROM (scope->>''ownershipEpoch'')::bigint THEN';
        replacement:='IF s.ownership_epoch IS DISTINCT FROM (scope->>''ownershipEpoch'')::bigint'
          ||' OR s.inbox_reopened_at IS DISTINCT FROM '
          ||'(scope->>''inboxReopenedAt'')::timestamptz THEN';
        IF (length(definition)-length(replace(definition,original,'')))
            /length(original)<>1 THEN
          RAISE EXCEPTION 'opening menu resume boundary patch target changed';
        END IF;
        definition:=replace(definition,original,replacement);
        original:='ownership_epoch=(scope->>''ownershipEpoch'')::bigint,';
        replacement:=original
          ||' inbox_reopened_at=(scope->>''inboxReopenedAt'')::timestamptz,';
        IF (length(definition)-length(replace(definition,original,'')))
            /length(original)<>1 THEN
          RAISE EXCEPTION 'opening menu reopen state patch target changed';
        END IF;
        definition:=replace(definition,original,replacement);
        original:='reopened:=previous_activity IS NULL OR received-previous_activity>=interval';
        replacement:='reopened:=s.status=''new'' OR previous_activity IS NULL'
          ||' OR received-previous_activity>=interval';
        IF (length(definition)-length(replace(definition,original,'')))
            /length(original)<>1 THEN
          RAISE EXCEPTION 'opening menu first offer patch target changed';
        END IF;
        EXECUTE replace(definition,original,replacement);
      END $migration$;
    """)


def downgrade() -> None:
    # Additive state is retained for mixed-version rollback.
    pass
