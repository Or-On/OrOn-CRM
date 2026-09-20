"""Deterministic, fictional UI records for an owned disposable preview database.

This module is not an application seed or runtime data source. The launcher passes
its newly-created database explicitly; both the URL and connected database name
are checked before any write. All channel records use the simulator provider.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from urllib.parse import urlsplit
from uuid import UUID, uuid5

import asyncpg

TENANT_ID = UUID("10000000-0000-4000-8000-000000000001")
USER_ID = UUID("20000000-0000-4000-8000-000000000001")
NAMESPACE = UUID("61000000-0000-4000-8000-000000000001")


def fixture_id(label: str) -> UUID:
    return uuid5(NAMESPACE, label)


def validate_fixture_database(url: str, database: str) -> None:
    parsed = urlsplit(url)
    if (
        parsed.scheme != "postgresql"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or re.fullmatch(r"oron_ui_preview_[a-zA-Z0-9]+", database) is None
        or parsed.path != f"/{database}"
    ):
        raise ValueError("Fictional UI fixtures require their owned localhost preview database")


async def seed_preview_fixtures(url: str, database: str) -> dict[str, str]:
    validate_fixture_database(url, database)
    connection = await asyncpg.connect(url, timeout=10)
    try:
        if await connection.fetchval("SELECT current_database()") != database:
            raise ValueError("Connected database does not match the owned UI preview")
        async with connection.transaction():
            await connection.execute(
                "SELECT set_config('app.current_tenant', $1, true), "
                "set_config('app.current_user', $2, true), "
                "set_config('app.current_role', 'owner', true)",
                str(TENANT_ID),
                str(USER_ID),
            )
            now = datetime.now(UTC).replace(second=0, microsecond=0)

            async def insert(table: str, **values: object) -> None:
                # Identifiers originate only in the literal fixture definitions below.
                if not re.fullmatch(r"[a-z_]+\.[a-z_]+", table) or any(
                    not re.fullmatch(r"[a-z_]+", column) for column in values
                ):
                    raise ValueError("Invalid fixture SQL identifier")
                placeholders = ", ".join(f"${index}" for index in range(1, len(values) + 1))
                await connection.execute(
                    f"INSERT INTO {table} ({', '.join(values)}) "  # noqa: S608 — literal identifiers validated above
                    f"VALUES ({placeholders}) ON CONFLICT DO NOTHING",
                    *values.values(),
                )

            await connection.execute(
                "UPDATE tenants SET name = 'Or-On Fictional Preview' WHERE id = $1", TENANT_ID
            )
            # A normal owner has every tenant workflow permission and does not
            # auto-select an unrelated migration bootstrap tenant during login.
            await connection.execute(
                "UPDATE users SET display_name = 'Fictional Preview Operator', "
                "is_superuser = false WHERE id = $1",
                USER_ID,
            )
            await insert(
                "crm.tenant_settings",
                tenant_id=TENANT_ID,
                display_name="Fictional Preview",
                default_currency="USD",
                locale="en",
                timezone="Asia/Jerusalem",
            )
            for index, role in enumerate(("admin", "agent", "viewer"), start=1):
                member_id = fixture_id(f"member-{index}")
                await insert(
                    "public.users",
                    id=member_id,
                    email=f"preview-{role}@example.invalid",
                    display_name=f"Fictional {role.title()}",
                    status="active",
                    is_superuser=False,
                )
                await insert(
                    "public.memberships", user_id=member_id, tenant_id=TENANT_ID, role=role
                )

            expense_records = (
                (
                    "Fictional workspace software",
                    "Preview Cloud",
                    "Software",
                    "184.00",
                    "USD",
                    "recorded",
                ),
                (
                    "Fictional call routing",
                    "Preview Telecom",
                    "Communications",
                    "72.40",
                    "USD",
                    "recorded",
                ),
                (
                    "Fictional studio rent",
                    "Preview Properties",
                    "Facilities",
                    "4200.00",
                    "ILS",
                    "recorded",
                ),
                (
                    "Fictional accessibility review",
                    "Preview Design",
                    "Professional services",
                    "680.00",
                    "USD",
                    "pending",
                ),
                ("נסיעת הדגמה", "ספק לדוגמה", "Travel", "245.00", "ILS", "recorded"),
                (
                    "Fictional team workshop",
                    "Preview Learning",
                    "People",
                    "310.00",
                    "USD",
                    "recorded",
                ),
            )
            for index, (title, vendor, category, amount, currency, status) in enumerate(
                expense_records
            ):
                await insert(
                    "finance.expenses",
                    id=fixture_id(f"expense-{index}"),
                    tenant_id=TENANT_ID,
                    created_by_user_id=USER_ID,
                    title=title,
                    vendor=vendor,
                    category=category,
                    amount=Decimal(amount),
                    currency=currency,
                    status=status,
                    source_kind="manual",
                    notes="Fictional preview ledger record.",
                    incurred_at=now - timedelta(days=index * 5 + 1),
                )

            task_records = (
                ("Review fictional onboarding brief", "in_progress", "high", 1, 1),
                ("Prepare preview account summary", "todo", "medium", 3, 2),
                ("Confirm simulator routing", "completed", "urgent", -1, 1),
                ("Draft customer follow-up", "todo", "low", 7, None),
                ("Audit the example workspace", "in_progress", "medium", 2, 3),
                ("Archive preview exports", "cancelled", "low", 5, None),
            )
            for index, (title, status, priority, due_days, member_index) in enumerate(task_records):
                completed_at = now - timedelta(hours=3) if status == "completed" else None
                await insert(
                    "crm.tasks",
                    id=fixture_id(f"task-{index}"),
                    tenant_id=TENANT_ID,
                    created_by_user_id=USER_ID,
                    assignee_user_id=(
                        fixture_id(f"member-{member_index}") if member_index is not None else None
                    ),
                    title=title,
                    description="Fictional preview task; no external action is performed.",
                    status=status,
                    priority=priority,
                    due_at=now + timedelta(days=due_days),
                    completed_at=completed_at,
                )

            calendar_records = (
                ("Fictional weekly planning", 1, 9, 60, "Meeting room A", "confirmed", 1),
                ("Preview customer review", 2, 13, 45, "Video call", "confirmed", 2),
                ("Team workflow workshop", 5, 10, 90, "Studio", "tentative", 3),
                ("דוח חודשי לדוגמה", 8, 11, 60, "חדר ישיבות", "confirmed", 1),
                ("Fictional operations retro", 12, 15, 45, "Video call", "confirmed", 2),
            )
            for index, (
                title,
                day_offset,
                hour,
                minutes,
                location,
                status,
                member_index,
            ) in enumerate(calendar_records):
                starts_at = (now + timedelta(days=day_offset)).replace(hour=hour, minute=0)
                await insert(
                    "crm.calendar_events",
                    id=fixture_id(f"calendar-event-{index}"),
                    tenant_id=TENANT_ID,
                    created_by_user_id=USER_ID,
                    organizer_user_id=fixture_id(f"member-{member_index}"),
                    title=title,
                    description="Fictional preview calendar event.",
                    location=location,
                    starts_at=starts_at,
                    ends_at=starts_at + timedelta(minutes=minutes),
                    all_day=False,
                    timezone="Asia/Jerusalem",
                    status=status,
                )

            # Metadata only: random preimages are immediately discarded. No usable
            # invitation link or API credential is created, logged or returned.
            await insert(
                "platform.tenant_invitations",
                id=fixture_id("settings-invitation"),
                tenant_id=TENANT_ID,
                invited_by_user_id=USER_ID,
                email="preview-invitee@example.invalid",
                role="agent",
                token_hash=hashlib.sha256(secrets.token_bytes(32)).hexdigest(),
                expires_at=now + timedelta(days=5),
                created_at=now - timedelta(days=2),
            )
            for index, status in enumerate(("active", "revoked")):
                await insert(
                    "public.api_keys",
                    id=fixture_id(f"settings-api-key-{status}"),
                    tenant_id=TENANT_ID,
                    kind="tenant",
                    name=(
                        "Fictional reporting integration"
                        if index == 0
                        else "Fictional retired sync"
                    ),
                    prefix=f"preview_{index}",
                    hashed_key=hashlib.sha256(secrets.token_bytes(32)).hexdigest(),
                    scopes=["crm:read"] if index == 0 else ["crm:read", "crm:write"],
                    status=status,
                    created_by_user_id=USER_ID,
                    created_at=now - timedelta(days=14 + index),
                    last_used_at=None if index == 0 else now - timedelta(days=3),
                    revoked_at=None if index == 0 else now - timedelta(days=2),
                )
            for index, (title, body) in enumerate(
                (
                    ("Fictional team update", "A fictional teammate joined the preview workspace."),
                    ("עדכון לדוגמה", "הגדרות סביבת העבודה לדוגמה עודכנו."),
                )
            ):
                await insert(
                    "messaging.notifications",
                    id=fixture_id(f"settings-notification-{index}"),
                    tenant_id=TENANT_ID,
                    user_id=USER_ID,
                    type="preview",
                    title=title,
                    body=body,
                    read_at=None if index == 0 else now - timedelta(hours=2),
                    created_at=now - timedelta(hours=3 + index),
                )

            channel_id = fixture_id("channel")
            await insert(
                "messaging.channels",
                id=channel_id,
                tenant_id=TENANT_ID,
                kind="whatsapp",
                provider="simulator",
                provider_account_id="fictional-preview-simulator",
                display_address="Fictional WhatsApp simulator",
                status="active",
                configuration=json.dumps({"mode": "simulator", "fictional": True}),
            )
            tag_id = fixture_id("tag")
            await insert("crm.tags", id=tag_id, tenant_id=TENANT_ID, name="Fictional preview")
            field_id = fixture_id("custom-field")
            await insert(
                "crm.custom_field_definitions",
                id=field_id,
                tenant_id=TENANT_ID,
                key="preview_tier",
                label="Preview tier",
                field_type="text",
            )
            names = (
                "Fictional Atlas",
                "Fictional Bloom",
                "לקוח לדוגמה — גלים",
                "Fictional Delta",
                "Fictional Ember",
                "Fictional Fern",
                "לקוחה לדוגמה — אופק",
                "Fictional Harbor",
                "Fictional Iris",
                "Fictional Juniper",
                "Fictional Kestrel",
                "Fictional Lumen",
            )
            previews = (
                "Could you help us with the next step in our fictional pilot?",
                "Thanks — the simulator follow-up is clear.",
                "שלום, אשמח לקבל פרטים נוספים על תהליך ההדגמה.",
                "We would like to review the proposal together.",
            )
            for index, name in enumerate(names):
                contact_id = fixture_id(f"contact-{index}")
                # NANP 555-0100–0199 is reserved for fictional use.
                phone = f"+120255501{index:02d}"
                await insert(
                    "crm.contacts",
                    id=contact_id,
                    tenant_id=TENANT_ID,
                    created_by_user_id=USER_ID,
                    assigned_user_id=USER_ID if index % 3 else None,
                    name=name,
                    email=f"preview-contact-{index}@example.invalid",
                    company=f"Fictional {('Studio', 'Labs', 'Works')[index % 3]}",
                    whatsapp_consent=("granted", "unknown", "granted", "revoked")[index % 4],
                    last_activity_at=now - timedelta(minutes=index * 17),
                    created_at=now - timedelta(days=14 - index),
                    metadata=json.dumps({"fictional": True}),
                )
                await insert(
                    "crm.contact_channel_identities",
                    id=fixture_id(f"identity-{index}"),
                    tenant_id=TENANT_ID,
                    contact_id=contact_id,
                    channel="whatsapp",
                    normalized_value=phone,
                    display_value=phone,
                    provider="simulator",
                    validation_status="valid",
                    is_primary=True,
                )
                await insert(
                    "crm.contact_tags", tenant_id=TENANT_ID, contact_id=contact_id, tag_id=tag_id
                )
                await insert(
                    "crm.contact_custom_field_values",
                    tenant_id=TENANT_ID,
                    contact_id=contact_id,
                    field_id=field_id,
                    value=json.dumps("Fictional pilot"),
                )
                await insert(
                    "crm.notes",
                    id=fixture_id(f"note-{index}"),
                    tenant_id=TENANT_ID,
                    contact_id=contact_id,
                    author_user_id=USER_ID,
                    body="Fictional preview record. No real customer or provider is involved.",
                )
                if index >= 8:
                    continue
                conversation_id = fixture_id(f"conversation-{index}")
                preview = previews[index % len(previews)]
                await insert(
                    "messaging.conversations",
                    id=conversation_id,
                    tenant_id=TENANT_ID,
                    channel_id=channel_id,
                    contact_id=contact_id,
                    assigned_user_id=USER_ID if index % 3 else None,
                    status=("open", "pending", "open", "resolved")[index % 4],
                    unread_count=(3, 0, 2, 0)[index % 4],
                    last_message_at=now - timedelta(minutes=index * 17),
                    last_message_preview=preview,
                    customer_service_window_expires_at=now + timedelta(hours=12),
                )
                for message_index in range(3):
                    inbound = message_index != 1
                    await insert(
                        "messaging.messages",
                        id=fixture_id(f"message-{index}-{message_index}"),
                        tenant_id=TENANT_ID,
                        conversation_id=conversation_id,
                        direction="inbound" if inbound else "outbound",
                        sender_type="contact" if inbound else "user",
                        sender_contact_id=contact_id if inbound else None,
                        sender_user_id=None if inbound else USER_ID,
                        content_type="text",
                        content_text=preview
                        if inbound
                        else "This is a simulator-only reply. Let’s review the next step.",
                        provider="simulator",
                        provider_message_id=f"preview-{index}-{message_index}",
                        status="received" if inbound else "read",
                        provider_payload=json.dumps({"fictional": True}),
                        created_at=now - timedelta(minutes=index * 17 + 6 - message_index * 3),
                    )

            pipeline_id = fixture_id("pipeline")
            await insert(
                "crm.pipelines",
                id=pipeline_id,
                tenant_id=TENANT_ID,
                name="Fictional customer journey",
                is_default=True,
            )
            for index, name in enumerate(("New opportunity", "Qualified", "Proposal", "Decision")):
                await insert(
                    "crm.pipeline_stages",
                    id=fixture_id(f"stage-{index}"),
                    tenant_id=TENANT_ID,
                    pipeline_id=pipeline_id,
                    name=name,
                    position=index,
                    probability=(10, 35, 65, 85)[index],
                )
            for index in range(9):
                deal_title = ("engagement pilot", "support workflow", "service expansion")[
                    index % 3
                ]
                await insert(
                    "crm.deals",
                    id=fixture_id(f"deal-{index}"),
                    tenant_id=TENANT_ID,
                    pipeline_id=pipeline_id,
                    stage_id=fixture_id(f"stage-{index % 4}"),
                    contact_id=fixture_id(f"contact-{index}"),
                    owner_user_id=USER_ID,
                    title=f"Fictional {deal_title}",
                    value=1250 * (index + 1),
                    currency="ILS" if index % 3 == 0 else "USD",
                    status="open",
                )

            template_id = fixture_id("template")
            await insert(
                "messaging.message_templates",
                id=template_id,
                tenant_id=TENANT_ID,
                channel_id=channel_id,
                name="fictional_preview_followup",
                language="en",
                category="UTILITY",
                status="approved",
                body="A fictional simulator-only follow-up.",
            )
            await insert(
                "messaging.quick_replies",
                id=fixture_id("quick-reply"),
                tenant_id=TENANT_ID,
                title="Fictional greeting",
                body="Thanks for reaching out in this fictional preview.",
                shortcut="/preview",
                created_by_user_id=USER_ID,
            )
            for index, status in enumerate(("draft", "sent", "failed", "scheduled")):
                campaign_name = (
                    "welcome series",
                    "pilot follow-up",
                    "delivery recovery",
                    "service reminder",
                )[index]
                campaign_id = fixture_id(f"campaign-{index}")
                broadcast_id = fixture_id(f"broadcast-{index}")
                await insert(
                    "platform.campaigns",
                    id=campaign_id,
                    tenant_id=TENANT_ID,
                    name=f"Fictional {campaign_name}",
                    status="completed" if status == "sent" else status,
                    channel="whatsapp",
                    created_by_user_id=USER_ID,
                    created_at=now - timedelta(days=index + 1),
                )
                await insert(
                    "messaging.broadcasts",
                    id=broadcast_id,
                    tenant_id=TENANT_ID,
                    campaign_id=campaign_id,
                    channel_id=channel_id,
                    template_id=template_id,
                    status=status,
                    total_recipients=8,
                    # The real recipient INSERT trigger owns the status counters.
                    # Presetting them would count these fictional recipients twice.
                    created_at=now - timedelta(days=index + 1),
                )
                for recipient in range(8):
                    await insert(
                        "messaging.broadcast_recipients",
                        id=fixture_id(f"recipient-{index}-{recipient}"),
                        tenant_id=TENANT_ID,
                        broadcast_id=broadcast_id,
                        contact_id=fixture_id(f"contact-{recipient}"),
                        template_params="[]",
                        status="delivered"
                        if status == "sent"
                        else "failed"
                        if status == "failed" and recipient < 2
                        else "pending",
                    )

            for index, name in enumerate(("Fictional service assistant", "עוזר הדגמה בעברית")):
                agent_id = fixture_id(f"agent-{index}")
                await insert(
                    "agents.agent_profiles",
                    id=agent_id,
                    tenant_id=TENANT_ID,
                    name=name,
                    description="Simulator-only preview profile",
                    created_by_user_id=USER_ID,
                )
                await insert(
                    "agents.agent_profile_versions",
                    id=fixture_id(f"agent-version-{index}"),
                    tenant_id=TENANT_ID,
                    agent_profile_id=agent_id,
                    version=1,
                    system_prompt=(
                        "Help with this fictional preview. Do not contact real providers."
                    ),
                    locale="he" if index else "en",
                    channel_capabilities=["whatsapp", "voice"],
                    validation_status="valid",
                    published_at=now if index == 0 else None,
                    created_by_user_id=USER_ID,
                )
            # Populated Leads UI acceptance uses only these owned fictional
            # records; this is never a live-tenant seed or a provider action.
            lead_records = (
                ("new", "whatsapp", "Fictional customer onboarding", None),
                (
                    "collecting",
                    "voice",
                    "Fictional support workflow evaluation",
                    "Review the pilot brief",
                ),
                (
                    "ready_for_review",
                    "whatsapp",
                    "בדיקת מערכת הדגמה לצוות שירות רב־ערוצי",
                    "תיאום שיחת הדגמה",
                ),
                (
                    "qualified",
                    "manual",
                    "Fictional multi-location rollout with a deliberately long "
                    "description to check narrow layouts",
                    "Prepare a fictional follow-up",
                ),
                ("disqualified", "api", "Fictional archived opportunity", None),
                ("converted", "manual", "Fictional completed evaluation", None),
            )
            for index, (status, source, objective, next_action) in enumerate(lead_records):
                await insert(
                    "crm.leads",
                    id=fixture_id(f"lead-{index}"),
                    tenant_id=TENANT_ID,
                    reference=f"LD-PREVIEW{index + 1:02d}",
                    contact_id=fixture_id(f"contact-{index}"),
                    source_channel=source,
                    agent_profile_version_id=(
                        fixture_id("agent-version-0") if source in {"voice", "whatsapp"} else None
                    ),
                    status=status,
                    business_objective=objective,
                    next_action=next_action,
                    owner_user_id=USER_ID if index % 2 else None,
                    created_by_user_id=USER_ID,
                    created_at=now - timedelta(days=index + 1),
                    updated_at=now - timedelta(minutes=index * 17),
                )
            for index in range(3):
                flow_id = fixture_id(f"flow-{index}")
                await insert(
                    "automation.flow_definitions",
                    id=flow_id,
                    tenant_id=TENANT_ID,
                    name=(
                        "Fictional welcome handoff",
                        "Fictional manual checklist",
                        "Fictional follow-up draft",
                    )[index],
                    description="Fictional simulator-only automation",
                    channel_capabilities=["whatsapp"],
                    created_by_user_id=USER_ID,
                )
                graph = (
                    {
                        "schemaVersion": "1.0",
                        "channels": ["whatsapp"],
                        "nodes": [
                            {"id": "start", "type": "start"},
                            {"id": "handoff", "type": "handoff"},
                            {"id": "end", "type": "end"},
                        ],
                        "edges": [
                            {"id": "a", "source": "start", "target": "handoff"},
                            {"id": "b", "source": "handoff", "target": "end"},
                        ],
                    }
                    if index != 1
                    else {"nodes": [], "edges": [], "trigger": {"type": "manual"}}
                )
                version_id = fixture_id(f"flow-version-{index}")
                await insert(
                    "automation.flow_versions",
                    id=version_id,
                    tenant_id=TENANT_ID,
                    flow_definition_id=flow_id,
                    version=1,
                    schema_version="1.0",
                    definition=json.dumps(graph),
                    validation_status="valid",
                    published_at=now - timedelta(days=1) if index != 2 else None,
                    created_by_user_id=USER_ID,
                )
                if index != 2:
                    await insert(
                        "automation.flow_runs",
                        id=fixture_id(f"run-{index}"),
                        tenant_id=TENANT_ID,
                        flow_version_id=version_id,
                        contact_id=fixture_id(f"contact-{index}"),
                        trigger_type="manual",
                        trigger_metadata=json.dumps({"mode": "simulator", "fictional": True}),
                        status="handed_off" if index == 0 else "succeeded",
                        started_at=now - timedelta(minutes=30 + index),
                        completed_at=now - timedelta(minutes=29 + index),
                    )
            for index in range(2):
                await insert(
                    "automation.handoffs",
                    id=fixture_id(f"handoff-{index}"),
                    tenant_id=TENANT_ID,
                    contact_id=fixture_id(f"contact-{index}"),
                    conversation_id=fixture_id(f"conversation-{index}"),
                    source_channel="whatsapp",
                    reason_safe="Fictional customer asked for operator assistance.",
                    status="pending",
                    idempotency_key=f"fictional-preview-handoff-{index}",
                    requested_by_user_id=USER_ID,
                    requested_at=now - timedelta(minutes=13 + index * 9),
                )
            return {
                "contact": str(fixture_id("contact-0")),
                "conversation": str(fixture_id("conversation-0")),
                "flow": str(fixture_id("flow-0")),
            }
    finally:
        await connection.close()
