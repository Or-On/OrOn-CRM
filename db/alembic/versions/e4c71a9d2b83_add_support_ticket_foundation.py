"""add the general support ticket foundation

One customer issue is one ticket; a ticket accumulates WhatsApp turns, call
attempts, recordings, summaries and human work. This is deliberately NOT
`crm.tasks` (internal work items that existing escalations already use) and NOT
`service.cases` (a field-service job carrying warranty, serial number, service
location and technician visits, available only when that optional feature is
enabled). A support ticket exists for every tenant, and a field-service case is
linked beside it rather than standing in for it.

Nothing here is destructive: no existing table is renamed, altered or
backfilled, and `crm.tasks` keeps its rows, audit history, permissions and
deep links.

Revision ID: e4c71a9d2b83
Revises: c5f7a90b41de
Create Date: 2026-09-18 18:10:00.000000
"""

# ruff: noqa: S608 -- generated SQL interpolates only closed migration constants.

from collections.abc import Sequence

from alembic import op

revision: str = "e4c71a9d2b83"
down_revision: str | None = "c5f7a90b41de"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SUPPORT_TABLES = (
    "tickets",
    "ticket_events",
    "ticket_call_attempts",
    "assurance_policies",
)


def _tenant_policy(table: str) -> None:
    qualified = f'"support"."{table}"'
    op.execute(f"ALTER TABLE {qualified} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {qualified} FORCE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY {table}_tenant_isolation ON {qualified} "
        "USING (tenant_id = platform.current_tenant_id()) "
        "WITH CHECK (tenant_id = platform.current_tenant_id())"
    )


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS support")

    # --- The issue -----------------------------------------------------------
    # `status` is the primary Open/Closed filter and `stage` is the detail under
    # it, because an operator filters on two questions at once: "what still
    # needs me" and "where exactly is it". Collapsing them into one column makes
    # every list view re-derive the grouping.
    #
    # `handling_mode` is the cross-channel ownership token. While voice owns the
    # issue, inbound WhatsApp is still persisted, but no competing AI reply may
    # be admitted for it — the messaging worker reads this column to decide.
    op.execute("""
        CREATE TABLE support.tickets (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          reference text NOT NULL,
          -- The admission that created this ticket. A redelivered webhook or a
          -- retried job repeats it, and the unique constraint — not a
          -- read-then-insert — is what makes "one issue, one ticket" hold when
          -- two workers race the same admission.
          attachment_key text NOT NULL,
          contact_id uuid NOT NULL,
          subject text NOT NULL,
          status text NOT NULL DEFAULT 'open',
          stage text NOT NULL DEFAULT 'new',
          priority text NOT NULL DEFAULT 'normal',
          handling_mode text NOT NULL DEFAULT 'ai_whatsapp',
          owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          source_channel text NOT NULL DEFAULT 'whatsapp',
          source_conversation_id uuid,
          service_case_id uuid,
          closure_reason text,
          resolution_classification text NOT NULL DEFAULT 'unknown',
          resolution_confirmed_by text NOT NULL DEFAULT 'none',
          next_action text,
          next_action_due_at timestamptz,
          -- Timeline positions are allocated by incrementing THIS column, not
          -- by reading max(sequence) from the events table. Every CTE in one
          -- statement shares a snapshot, so a `FOR UPDATE` on the ticket does
          -- not stop a concurrent writer computing the same max; an UPDATE ...
          -- RETURNING re-reads the row after the lock and cannot.
          next_event_sequence integer NOT NULL DEFAULT 0,
          last_activity_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          opened_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          closed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, reference),
          CONSTRAINT uq_support_tickets_attachment UNIQUE (tenant_id, attachment_key),
          FOREIGN KEY (tenant_id, contact_id)
            REFERENCES crm.contacts(tenant_id, id) ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, source_conversation_id)
            REFERENCES messaging.conversations(tenant_id, id) ON DELETE RESTRICT,
          -- A technician job is a RELATED record, never the ticket itself, and
          -- the optional field-service feature may be off entirely.
          FOREIGN KEY (tenant_id, service_case_id)
            REFERENCES service.cases(tenant_id, id) ON DELETE SET NULL (service_case_id),
          CONSTRAINT ck_support_ticket_status CHECK (status IN ('open','closed')),
          CONSTRAINT ck_support_ticket_stage CHECK (
            stage IN ('new','ai_handling','callback_pending','in_call',
                      'awaiting_customer','awaiting_human','closed')
          ),
          CONSTRAINT ck_support_ticket_priority CHECK (
            priority IN ('low','normal','high','urgent')
          ),
          CONSTRAINT ck_support_ticket_handling CHECK (
            handling_mode IN ('ai_whatsapp','ai_voice','human','paused')
          ),
          CONSTRAINT ck_support_ticket_source CHECK (
            source_channel IN ('whatsapp','voice','manual')
          ),
          CONSTRAINT ck_support_ticket_closure CHECK (
            closure_reason IS NULL
            OR closure_reason IN ('resolved','cancelled','duplicate','administrative')
          ),
          -- Only an evidence-backed resolution may ever count toward an AI
          -- success metric, so the two columns are constrained together rather
          -- than left for a reporting query to reconcile.
          CONSTRAINT ck_support_ticket_resolution CHECK (
            resolution_classification IN
              ('unknown','unresolved','proposed_fix_awaiting_confirmation','resolved')
          ),
          CONSTRAINT ck_support_ticket_confirmation CHECK (
            resolution_confirmed_by IN ('none','customer','authoritative_evidence')
          ),
          CONSTRAINT ck_support_ticket_resolved_needs_evidence CHECK (
            resolution_classification <> 'resolved'
            OR resolution_confirmed_by <> 'none'
          ),
          CONSTRAINT ck_support_ticket_closed_has_reason CHECK (
            status <> 'closed' OR (closure_reason IS NOT NULL AND closed_at IS NOT NULL)
          ),
          CONSTRAINT ck_support_ticket_closed_stage CHECK (
            (status = 'closed') = (stage = 'closed')
          )
        )
    """)

    # The operator's default view: open work for this tenant, most recently
    # active first. Paginated server-side; a tenant's whole history never goes
    # to the browser.
    op.execute("""
        CREATE INDEX ix_support_tickets_open_queue
          ON support.tickets (tenant_id, last_activity_at DESC, id DESC)
          WHERE status = 'open'
    """)
    op.execute("""
        CREATE INDEX ix_support_tickets_contact
          ON support.tickets (tenant_id, contact_id, last_activity_at DESC)
    """)
    # Phone/reference lookup arrives from a customer quoting it, so it must not
    # scan: the conversation lookup is how an inbound message finds its issue.
    op.execute("""
        CREATE INDEX ix_support_tickets_source_conversation
          ON support.tickets (tenant_id, source_conversation_id)
          WHERE source_conversation_id IS NOT NULL
    """)

    # --- The timeline --------------------------------------------------------
    # Append-only. `summary_safe` is operator-facing prose that must not carry a
    # transcript, an identifier or a payment value; the `evidence` column holds
    # typed REFERENCES so the UI can link to the real artifact behind the
    # authenticated boundary instead of copying it here.
    op.execute("""
        CREATE TABLE support.ticket_events (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          ticket_id uuid NOT NULL,
          sequence integer NOT NULL,
          kind text NOT NULL,
          actor_kind text NOT NULL,
          actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          visibility text NOT NULL DEFAULT 'internal',
          summary_safe text NOT NULL,
          evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, ticket_id, sequence),
          FOREIGN KEY (tenant_id, ticket_id)
            REFERENCES support.tickets(tenant_id, id) ON DELETE CASCADE,
          CONSTRAINT ck_support_event_kind CHECK (
            kind IN ('opened','reopened','customer_message','agent_message',
                     'call_attempt','call_outcome','recording_state',
                     'summary','status_change','assignment','human_note',
                     'customer_update','escalation','action_result')
          ),
          CONSTRAINT ck_support_event_actor CHECK (
            actor_kind IN ('customer','ai','human','system')
          ),
          CONSTRAINT ck_support_event_visibility CHECK (
            visibility IN ('internal','customer_visible')
          ),
          CONSTRAINT ck_support_event_evidence_object CHECK (jsonb_typeof(evidence) = 'object')
        )
    """)
    op.execute("""
        CREATE INDEX ix_support_ticket_events_timeline
          ON support.ticket_events (tenant_id, ticket_id, sequence DESC)
    """)

    # --- Call attempts -------------------------------------------------------
    # Busy, no answer, voicemail, refusal, cancellation, disconnect and provider
    # timeout are DISTINCT outcomes and none of them resolves a ticket. The
    # recording is tracked by readiness state, because a stored URI is not a
    # playable file: `ready` is only written after the object has been verified.
    op.execute("""
        CREATE TABLE support.ticket_call_attempts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          ticket_id uuid NOT NULL,
          attempt_number integer NOT NULL,
          session_id uuid,
          handoff_id uuid,
          job_id uuid,
          destination_identity_id uuid,
          assurance_level text NOT NULL DEFAULT 'none',
          assurance_policy_version integer,
          outcome text NOT NULL DEFAULT 'queued',
          recording_state text NOT NULL DEFAULT 'pending',
          recording_object_id uuid,
          transcript_object_id uuid,
          summary_state text NOT NULL DEFAULT 'pending',
          queued_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          started_at timestamptz,
          ended_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, ticket_id, attempt_number),
          FOREIGN KEY (tenant_id, ticket_id)
            REFERENCES support.tickets(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, handoff_id)
            REFERENCES automation.handoffs(tenant_id, id) ON DELETE SET NULL (handoff_id),
          CONSTRAINT ck_support_attempt_outcome CHECK (
            outcome IN ('queued','dialing','answered','no_answer','busy','voicemail',
                        'refused','cancelled','disconnected','provider_timeout','failed')
          ),
          CONSTRAINT ck_support_attempt_assurance CHECK (
            assurance_level IN ('none','channel_associated','callback_confirmed','verified')
          ),
          CONSTRAINT ck_support_attempt_recording CHECK (
            recording_state IN ('pending','processing','ready','partial','failed','unavailable')
          ),
          CONSTRAINT ck_support_attempt_summary CHECK (
            summary_state IN ('pending','processing','ready','failed')
          ),
          -- A recording is only claimed playable once an object backs it.
          CONSTRAINT ck_support_attempt_ready_has_object CHECK (
            recording_state NOT IN ('ready','partial') OR recording_object_id IS NOT NULL
          )
        )
    """)
    op.execute("""
        CREATE INDEX ix_support_call_attempts_ticket
          ON support.ticket_call_attempts (tenant_id, ticket_id, attempt_number DESC)
    """)
    # Reconciling an ambiguous dial acceptance looks the attempt up by the
    # canonical session rather than placing another call.
    op.execute("""
        CREATE UNIQUE INDEX ix_support_call_attempts_session
          ON support.ticket_call_attempts (tenant_id, session_id)
          WHERE session_id IS NOT NULL
    """)

    # --- Tenant assurance policy --------------------------------------------
    # Phone-first is a tenant DECISION, not a global downgrade. A tenant with no
    # row keeps the existing stronger verification path, because the default
    # here is the conservative one and an absent row cannot lower it.
    op.execute("""
        CREATE TABLE support.assurance_policies (
          tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
          version integer NOT NULL DEFAULT 1,
          callback_minimum text NOT NULL DEFAULT 'verified',
          low_assurance_context text NOT NULL DEFAULT 'none',
          updated_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT ck_support_assurance_minimum CHECK (
            callback_minimum IN ('channel_associated','callback_confirmed','verified')
          ),
          -- What a LOW-assurance call may be told. `none` and
          -- `bounded_nonsensitive` are the only safe values: prior message
          -- bodies, identifiers and privileged actions stay behind 'verified'.
          CONSTRAINT ck_support_assurance_context CHECK (
            low_assurance_context IN ('none','bounded_nonsensitive')
          )
        )
    """)

    for table in SUPPORT_TABLES:
        _tenant_policy(table)

    op.execute("""
        GRANT USAGE ON SCHEMA support
          TO platform_web, platform_worker, platform_messaging,
             platform_voice, platform_readonly
    """)
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA support TO platform_web"
    )
    op.execute("GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA support TO platform_worker")
    op.execute("GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA support TO platform_messaging")
    # The voice runtime reports what happened on its own call and reads the
    # issue it was dialed about. It never opens or closes a ticket itself.
    op.execute("""
        GRANT SELECT ON support.tickets, support.assurance_policies TO platform_voice
    """)
    op.execute("""
        GRANT SELECT, INSERT, UPDATE ON
          support.ticket_call_attempts, support.ticket_events TO platform_voice
    """)
    op.execute("GRANT SELECT ON ALL TABLES IN SCHEMA support TO platform_readonly")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS support.ticket_call_attempts")
    op.execute("DROP TABLE IF EXISTS support.ticket_events")
    op.execute("DROP TABLE IF EXISTS support.assurance_policies")
    op.execute("DROP TABLE IF EXISTS support.tickets")
    op.execute("DROP SCHEMA IF EXISTS support")
