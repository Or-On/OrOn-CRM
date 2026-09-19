"""bind inbound voice callers and allow verified ticket creation

Revision ID: 0f7b3c9d2a61
Revises: e4c71a9d2b83
Create Date: 2026-09-19 22:15:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0f7b3c9d2a61"
down_revision: str | None = "e4c71a9d2b83"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Caller ID is transport context, not a value the model should ask the
    # person to repeat. The function first reuses a canonical phone/WhatsApp
    # identity. Only a genuinely new number gets a minimal contact, matching
    # inbound WhatsApp's existing admission behaviour. Ambiguous identities
    # fail closed by returning NULL rather than guessing between customers.
    op.execute(
        r"""
        CREATE FUNCTION platform.resolve_voice_caller_contact(p_phone_e164 text)
        RETURNS uuid
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path=pg_catalog
        AS $$
        DECLARE
          v_tenant uuid := platform.current_tenant_id();
          v_contacts uuid[];
          v_contact uuid;
        BEGIN
          IF v_tenant IS NULL
             OR p_phone_e164 IS NULL
             OR p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' THEN
            RETURN NULL;
          END IF;

          PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(v_tenant::text || ':' || p_phone_e164, 0)
          );
          SELECT pg_catalog.array_agg(candidate.contact_id ORDER BY candidate.contact_id)
          INTO v_contacts
          FROM (
            SELECT DISTINCT identity.contact_id
            FROM crm.contact_channel_identities AS identity
            WHERE identity.tenant_id=v_tenant
              AND identity.channel IN ('phone','whatsapp')
              AND identity.normalized_value=p_phone_e164
              AND identity.validation_status NOT IN ('invalid','revoked')
          ) AS candidate;

          IF pg_catalog.coalesce(pg_catalog.array_length(v_contacts, 1), 0) > 1 THEN
            RETURN NULL;
          END IF;
          IF pg_catalog.array_length(v_contacts, 1) = 1 THEN
            UPDATE crm.contacts
            SET last_activity_at=pg_catalog.clock_timestamp(),
                updated_at=pg_catalog.clock_timestamp()
            WHERE tenant_id=v_tenant AND id=v_contacts[1];
            RETURN v_contacts[1];
          END IF;

          INSERT INTO crm.contacts(tenant_id,name,last_activity_at)
          VALUES(v_tenant,p_phone_e164,pg_catalog.clock_timestamp())
          RETURNING id INTO v_contact;
          INSERT INTO crm.contact_channel_identities(
            tenant_id,contact_id,channel,normalized_value,display_value,
            provider,validation_status,is_primary
          ) VALUES(
            v_tenant,v_contact,'phone',p_phone_e164,p_phone_e164,
            'livekit','unverified',true
          );
          RETURN v_contact;
        END;
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION platform.resolve_voice_caller_contact(text) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.resolve_voice_caller_contact(text) TO platform_voice"
    )

    # The model never writes ticket tables. It can request this one bounded,
    # tenant-scoped capability and may only claim success after the returned
    # receipt exists. The voice-session attachment key makes retries and
    # duplicate tool calls converge on the same ticket.
    op.execute(
        r"""
        CREATE FUNCTION support.open_ticket_from_voice_session(
          p_session_id uuid, p_subject text, p_summary_safe text
        ) RETURNS jsonb
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path=pg_catalog
        AS $$
        DECLARE
          v_tenant uuid := platform.current_tenant_id();
          v_contact uuid;
          v_subject text := pg_catalog.btrim(
            pg_catalog.regexp_replace(pg_catalog.coalesce(p_subject,''), '\s+', ' ', 'g')
          );
          v_summary text := pg_catalog.btrim(
            pg_catalog.regexp_replace(pg_catalog.coalesce(p_summary_safe,''), '\s+', ' ', 'g')
          );
          v_id uuid := pg_catalog.gen_random_uuid();
          v_ticket uuid;
          v_reference text;
          v_created boolean := false;
        BEGIN
          IF v_tenant IS NULL THEN
            RAISE EXCEPTION 'tenant context is required' USING ERRCODE='42501';
          END IF;
          IF pg_catalog.char_length(v_subject) NOT BETWEEN 1 AND 240 THEN
            RAISE EXCEPTION 'ticket subject is invalid' USING ERRCODE='22023';
          END IF;
          IF pg_catalog.char_length(v_summary) NOT BETWEEN 1 AND 2000 THEN
            RAISE EXCEPTION 'ticket summary is invalid' USING ERRCODE='22023';
          END IF;

          SELECT session.contact_id
          INTO v_contact
          FROM public.sessions AS session
          WHERE session.tenant_id=v_tenant
            AND session.session_id=p_session_id;
          IF v_contact IS NULL THEN
            RAISE EXCEPTION 'voice caller is not associated with a contact'
              USING ERRCODE='23503';
          END IF;

          INSERT INTO support.tickets(
            id,tenant_id,reference,attachment_key,contact_id,subject,
            source_channel,stage,handling_mode
          ) VALUES(
            v_id,v_tenant,
            'T-' || pg_catalog.to_char(CURRENT_TIMESTAMP, 'YYYY') || '-' ||
              pg_catalog.upper(pg_catalog.left(pg_catalog.replace(v_id::text, '-', ''), 8)),
            'voice-session:' || p_session_id::text,v_contact,v_subject,
            'voice','ai_handling','ai_voice'
          )
          ON CONFLICT ON CONSTRAINT uq_support_tickets_attachment DO NOTHING
          RETURNING id,reference INTO v_ticket,v_reference;

          IF v_ticket IS NULL THEN
            SELECT ticket.id,ticket.reference
            INTO v_ticket,v_reference
            FROM support.tickets AS ticket
            WHERE ticket.tenant_id=v_tenant
              AND ticket.attachment_key='voice-session:' || p_session_id::text;
          ELSE
            v_created := true;
            UPDATE support.tickets
            SET next_event_sequence=1,
                last_activity_at=pg_catalog.clock_timestamp(),
                updated_at=pg_catalog.clock_timestamp()
            WHERE tenant_id=v_tenant AND id=v_ticket;
            INSERT INTO support.ticket_events(
              tenant_id,ticket_id,sequence,kind,actor_kind,visibility,
              summary_safe,evidence
            ) VALUES(
              v_tenant,v_ticket,1,'opened','ai','internal',v_summary,
              pg_catalog.jsonb_build_object('sessionId',p_session_id::text)
            );
          END IF;

          IF v_ticket IS NULL OR v_reference IS NULL THEN
            RAISE EXCEPTION 'support ticket was not created';
          END IF;
          RETURN pg_catalog.jsonb_build_object(
            'ticketId',v_ticket::text,
            'reference',v_reference,
            'created',v_created
          );
        END;
        $$
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION support.open_ticket_from_voice_session(uuid,text,text) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION support.open_ticket_from_voice_session(uuid,text,text) "
        "TO platform_voice"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS support.open_ticket_from_voice_session(uuid,text,text)")
    op.execute("DROP FUNCTION IF EXISTS platform.resolve_voice_caller_contact(text)")
