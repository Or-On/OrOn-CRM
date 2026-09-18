"""Voice lead capture through the real ``platform.lead_*`` functions.

Runs the voice runtime's own tool layer and PostgreSQL adapter under the
least-privileged ``platform_voice`` role. No call, model or provider is started:
the model's tool calls are issued directly, so this proves the durable path,
not model behaviour.
"""

from __future__ import annotations

import json
from uuid import uuid4

import pytest
from dispatcher_runtime.persistence import PostgresVoiceLeadStore, _async_database_url
from oron_agent.lead_capture import (
    AcceptedTurns,
    LeadStoreRefusal,
    VoiceLeadTools,
    normalize_lead_field,
    parse_lead_field_schema,
)
from oron_common import CallContext
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from db.tests.postgres.lead_capture_support import (
    admit_callback,
    call_context,
    execute,
    seed_call,
    seed_tenant,
)

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]

FIELDS = [
    {"key": "preferred_name", "label": "Preferred name", "type": "text", "required": True},
    {"key": "company", "label": "Company", "type": "text", "required": True},
    {"key": "seats", "label": "Users", "type": "number", "required": False, "minimum": 1},
    {"key": "budget", "label": "Budget", "type": "currency", "required": False},
]
LEAD_CAPABILITIES = ["lead.read", "lead.write", "lead.finalize", "lead.follow_up"]


async def _fixture(connection: AsyncConnection) -> dict:
    return await seed_tenant(connection, fields=FIELDS, capabilities=LEAD_CAPABILITIES)


def _tools(maker, fixture: dict, context: CallContext, agent: str | None = None):
    store = PostgresVoiceLeadStore(
        maker,
        context,
        agent_version_id=agent or fixture["lead_agent"],
        schema_id=fixture["schema"]["id"],
        schema_version=fixture["schema"]["version"],
        business_objective="Business software enquiry",
    )
    turns = AcceptedTurns()
    tools = VoiceLeadTools(
        store=store,
        schema=parse_lead_field_schema(FIELDS),
        capabilities=LEAD_CAPABILITIES,
        interaction_key=str(context.session_id),
        turns=turns,
    )
    return store, turns, tools


async def _open_whatsapp_lead(connection: AsyncConnection, fixture: dict) -> str:
    """The WhatsApp half, through the same functions the TypeScript worker calls."""

    binding = json.dumps(
        {
            "contactId": str(fixture["contact"]),
            "sourceChannel": "whatsapp",
            "recordedBy": "agent",
            "agentProfileVersionId": fixture["lead_agent"],
            "actorUserId": str(fixture["user"]),
            "conversationId": str(fixture["conversation"]),
        }
    )
    await execute(connection, "SET LOCAL ROLE platform_messaging")
    await execute(
        connection,
        "SELECT set_config('app.current_tenant',:tenant,true)",
        tenant=str(fixture["tenant"]),
    )
    opened = (
        await execute(
            connection,
            "SELECT platform.lead_ensure_for_interaction(CAST(:binding AS jsonb),:key,"
            "CAST(:schema AS uuid),1,'Business software enquiry',NULL,CAST(:message AS uuid))",
            binding=binding,
            key=f"whatsapp-open-{uuid4()}",
            schema=fixture["schema"]["id"],
            message=str(fixture["message"]),
        )
    ).scalar_one()
    lead_id = (
        json.loads(opened)["receipt"]["leadId"]
        if isinstance(opened, str)
        else opened["receipt"]["leadId"]
    )
    company = normalize_lead_field(
        parse_lead_field_schema(FIELDS),
        {
            "key": "company",
            "state": "known",
            "value": "Fictional Systems",
            "sourceReferenceId": str(fixture["message"]),
        },
    )
    await execute(
        connection,
        "SELECT platform.lead_save_fields(CAST(:binding AS jsonb),CAST(:lead AS uuid),:key,"
        "NULL,CAST(:observations AS jsonb))",
        binding=binding,
        lead=lead_id,
        key=f"whatsapp-save-{uuid4()}",
        observations=json.dumps([company]),
    )
    await execute(connection, "RESET ROLE")
    return lead_id


async def test_voice_continues_the_whatsapp_lead_and_receipts_are_durable(postgres_url):
    engine = create_async_engine(_async_database_url(postgres_url))
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                fixture = await _fixture(connection)
                whatsapp_lead = await _open_whatsapp_lead(connection, fixture)
                linked, handoff = await admit_callback(connection, fixture, unlocked=True)
                # An ordinary call to the same person, not a callback for anything.
                unrelated = await seed_call(connection, fixture["tenant"], fixture["contact"])
                maker = async_sessionmaker(
                    bind=connection,
                    class_=AsyncSession,
                    expire_on_commit=False,
                    join_transaction_mode="create_savepoint",
                )
                await execute(connection, "SET LOCAL ROLE platform_voice")

                _, turns, tools = _tools(
                    maker,
                    fixture,
                    call_context(
                        fixture, linked, conversation=fixture["conversation"], handoff=handoff
                    ),
                )
                turns.accept()
                state = await tools.run("lead_read_state", {})
                # The callback sees what WhatsApp collected, so it need not ask again.
                assert state["ok"] is True
                assert {"key": "company", "state": "known", "value": "Fictional Systems"} in state[
                    "collected"
                ]
                assert state["missingRequired"] == ["preferred_name"]
                assert tools.lead_id == whatsapp_lead

                arguments = {
                    "observations": [
                        {
                            "key": "preferred_name",
                            "state": "known",
                            "value": "רוני",
                            "confirmed": True,
                        },
                        {"key": "seats", "state": "known", "value": "25"},
                        {"key": "budget", "state": "declined"},
                    ]
                }
                saved = await tools.run("lead_save_fields", arguments)
                assert saved["ok"] is True and saved["saved"] is True
                assert saved["changed"] == ["preferred_name", "seats", "budget"]
                assert saved["missingRequired"] == []
                assert turns.receipt_for_current_turn() is True

                # A redelivered tool call in the same turn replays its receipt.
                replay = await tools.run("lead_save_fields", arguments)
                assert replay["revision"] == saved["revision"]

                # A call never linked to that conversation does not adopt its lead.
                _, other_turns, stranger = _tools(maker, fixture, call_context(fixture, unrelated))
                other_turns.accept()
                assert (await stranger.run("lead_read_state", {}))["collected"] == []
                assert stranger.lead_id is None

                await execute(connection, "RESET ROLE")
                rows = (
                    await execute(
                        connection,
                        "SELECT field_key, source_channel, source_reference_id, "
                        "confirmation_status FROM crm.lead_field_values "
                        "WHERE lead_id=CAST(:lead AS uuid) "
                        "AND superseded_at IS NULL ORDER BY field_key",
                        lead=whatsapp_lead,
                    )
                ).all()
                assert [tuple(row) for row in rows] == [
                    ("budget", "voice", "turn-1", "unconfirmed"),
                    ("company", "whatsapp", str(fixture["message"]), "unconfirmed"),
                    ("preferred_name", "voice", "turn-1", "customer_confirmed"),
                    ("seats", "voice", "turn-1", "unconfirmed"),
                ]
                links = (
                    (
                        await execute(
                            connection,
                            "SELECT channel FROM crm.lead_interactions "
                            "WHERE lead_id=CAST(:lead AS uuid) ORDER BY channel",
                            lead=whatsapp_lead,
                        )
                    )
                    .scalars()
                    .all()
                )
                assert links == ["voice", "whatsapp"]
                audit = (
                    (
                        await execute(
                            connection,
                            "SELECT actor_service FROM audit.records WHERE target_type='lead' "
                            "AND target_id=CAST(:lead AS uuid) "
                            "AND metadata->>'sourceChannel'='voice'",
                            lead=whatsapp_lead,
                        )
                    )
                    .scalars()
                    .all()
                )
                assert audit and set(audit) == {"voice-agent"}
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()


async def test_database_refuses_voice_writes_it_must_not_accept(postgres_url):
    engine = create_async_engine(_async_database_url(postgres_url))
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                fixture = await _fixture(connection)
                lead = await _open_whatsapp_lead(connection, fixture)
                call, handoff = await admit_callback(connection, fixture, unlocked=True)
                maker = async_sessionmaker(
                    bind=connection,
                    class_=AsyncSession,
                    expire_on_commit=False,
                    join_transaction_mode="create_savepoint",
                )
                observation = normalize_lead_field(
                    parse_lead_field_schema(FIELDS),
                    {"key": "seats", "state": "known", "value": "4", "sourceReferenceId": "turn-1"},
                )
                context = call_context(
                    fixture, call, conversation=fixture["conversation"], handoff=handoff
                )
                await execute(connection, "SET LOCAL ROLE platform_voice")

                # A survey agent's version holds no lead capability. Even a runtime
                # bug that offered it the tool could not make the database write.
                survey_store, _, _ = _tools(maker, fixture, context, fixture["survey_agent"])
                with pytest.raises(LeadStoreRefusal) as denied:
                    await survey_store.save_fields(lead, f"survey-{uuid4()}", [observation])
                assert denied.value.code == "LD403"

                # A person pauses the call: a late write from the old worker is fenced.
                await execute(connection, "RESET ROLE")
                await execute(
                    connection,
                    "INSERT INTO public.voice_session_controls(tenant_id,session_id,desired_mode) "
                    "VALUES(:tenant,:session,'paused')",
                    tenant=fixture["tenant"],
                    session=call,
                )
                await execute(connection, "SET LOCAL ROLE platform_voice")
                store, _, _ = _tools(maker, fixture, context)
                with pytest.raises(LeadStoreRefusal) as fenced:
                    await store.save_fields(lead, f"late-{uuid4()}", [observation])
                assert fenced.value.code == "LD423"

                # A call cannot claim a conversation it was not admitted for.
                await execute(connection, "RESET ROLE")
                bare = await seed_call(connection, fixture["tenant"], fixture["contact"])
                await execute(connection, "SET LOCAL ROLE platform_voice")
                claiming, _, _ = _tools(
                    maker,
                    fixture,
                    call_context(
                        fixture, bare, conversation=fixture["conversation"], handoff=handoff
                    ),
                )
                with pytest.raises(LeadStoreRefusal) as unbound:
                    await claiming.capture_state(None)
                assert unbound.value.code == "LD404"
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()


async def test_secured_callback_reaches_the_lead_only_after_verification(postgres_url):
    engine = create_async_engine(_async_database_url(postgres_url))
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                fixture = await _fixture(connection)
                await _open_whatsapp_lead(connection, fixture)
                call, handoff = await admit_callback(connection, fixture, unlocked=False)
                maker = async_sessionmaker(
                    bind=connection,
                    class_=AsyncSession,
                    expire_on_commit=False,
                    join_transaction_mode="create_savepoint",
                )
                await execute(connection, "SET LOCAL ROLE platform_voice")
                _, turns, tools = _tools(
                    maker,
                    fixture,
                    call_context(
                        fixture, call, conversation=fixture["conversation"], handoff=handoff
                    ),
                )
                turns.accept()
                # Knowing the phone number is not identity: nothing from the
                # WhatsApp enquiry is readable, and nothing can be written into it.
                locked = await tools.run("lead_read_state", {})
                assert locked == {"ok": False, "error": "the action was refused", "code": "LD423"}
                write = await tools.run(
                    "lead_save_fields",
                    {"observations": [{"key": "seats", "state": "known", "value": "3"}]},
                )
                assert write["ok"] is False and write["code"] == "LD423"
                assert turns.receipt_for_current_turn() is False
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()
