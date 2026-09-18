"""Seeding shared by the lead capture tests that run against real PostgreSQL.

One tenant, one contact, one WhatsApp conversation and one secured voice
callback: the smallest world in which ``platform.lead_*`` can be asked to do
anything. Every identifier is generated, and every name is fictional.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID, uuid4

from oron_common import CallContext, Direction
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection


async def execute(connection: AsyncConnection, sql: str, **parameters: object):
    return await connection.execute(text(sql), parameters)


async def seed_agent(
    connection: AsyncConnection,
    tenant: UUID,
    permissions: list[str],
    *,
    channels: tuple[str, ...] = ("voice", "whatsapp"),
) -> str:
    profile = uuid4()
    await execute(
        connection,
        "INSERT INTO agents.agent_profiles(id,tenant_id,name) VALUES(:id,:tenant,:name)",
        id=profile,
        tenant=tenant,
        name=f"Fictional agent {profile}",
    )
    version = uuid4()
    await execute(
        connection,
        """
        INSERT INTO agents.agent_profile_versions
          (id,tenant_id,agent_profile_id,version,system_prompt,locale,
           channel_capabilities,tool_permissions,validation_status,published_at)
        VALUES(:id,:tenant,:profile,1,'Fictional agent for tests.','he',
               CAST(:channels AS text[]),CAST(:permissions AS jsonb),'valid',
               CURRENT_TIMESTAMP)
        """,
        id=version,
        tenant=tenant,
        profile=profile,
        channels=list(channels),
        permissions=json.dumps(permissions),
    )
    return str(version)


async def seed_call(
    connection: AsyncConnection,
    tenant: UUID,
    contact: UUID,
    *,
    conversation: UUID | None = None,
    handoff: UUID | None = None,
) -> UUID:
    session = uuid4()
    await execute(
        connection,
        "INSERT INTO public.sessions(session_id,tenant_id,contact_id,provider,direction,"
        "room,status,flow_id) VALUES(:session,:tenant,:contact,'livekit','outbound',"
        ":room,'started',:flow)",
        session=session,
        tenant=tenant,
        contact=contact,
        room=f"lead-call-{session}",
        flow=uuid4(),
    )
    # What the dispatcher records when it admits a callback for a conversation.
    await execute(
        connection,
        "INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,payload) "
        "VALUES(:tenant,:session,0,'voice.call.admission.v1',CAST(:payload AS jsonb))",
        tenant=tenant,
        session=session,
        payload=json.dumps(
            {
                "source_conversation_id": str(conversation) if conversation else None,
                "handoff_id": str(handoff) if handoff else None,
            }
        ),
    )
    return session


async def seed_tenant(
    connection: AsyncConnection,
    *,
    fields: list[dict[str, Any]],
    capabilities: list[str],
    schema_name: str = "Fictional coordinator",
) -> dict[str, Any]:
    tenant, user, contact = uuid4(), uuid4(), uuid4()
    await execute(
        connection,
        "INSERT INTO tenants(id,name,slug,status) VALUES(:id,'Fictional voice leads',:slug,"
        "'active')",
        id=tenant,
        slug=f"voice-leads-{tenant}",
    )
    await execute(
        connection,
        "INSERT INTO users(id,email,status) VALUES(:id,:email,'active')",
        id=user,
        email=f"voice-leads-{user}@example.invalid",
    )
    await execute(
        connection,
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES(:tenant,:user,'owner')",
        tenant=tenant,
        user=user,
    )
    await execute(
        connection, "INSERT INTO crm.tenant_settings(tenant_id) VALUES(:tenant)", tenant=tenant
    )
    await execute(
        connection,
        "INSERT INTO crm.contacts(id,tenant_id,name) VALUES(:id,:tenant,'Fictional caller')",
        id=contact,
        tenant=tenant,
    )
    channel = (
        await execute(
            connection,
            "INSERT INTO messaging.channels(tenant_id,kind,provider,provider_account_id,status) "
            "VALUES(:tenant,'whatsapp','simulator',:account,'active') RETURNING id",
            tenant=tenant,
            account=f"voice-leads-{tenant}",
        )
    ).scalar_one()
    conversation = (
        await execute(
            connection,
            "INSERT INTO messaging.conversations(tenant_id,channel_id,contact_id) "
            "VALUES(:tenant,:channel,:contact) RETURNING id",
            tenant=tenant,
            channel=channel,
            contact=contact,
        )
    ).scalar_one()
    message = (
        await execute(
            connection,
            "INSERT INTO messaging.messages(tenant_id,conversation_id,direction,sender_type,"
            "content_type,content_text,provider,status) VALUES(:tenant,:conversation,"
            "'inbound','contact','text','Fictional enquiry','simulator','received') "
            "RETURNING id",
            tenant=tenant,
            conversation=conversation,
        )
    ).scalar_one()
    schema = (
        await execute(
            connection,
            "INSERT INTO crm.lead_field_schemas(tenant_id,name,version,definition,published_at) "
            "VALUES(:tenant,:name,1,CAST(:definition AS jsonb),CURRENT_TIMESTAMP) RETURNING id",
            tenant=tenant,
            name=schema_name,
            definition=json.dumps(fields),
        )
    ).scalar_one()
    return {
        "tenant": tenant,
        "user": user,
        "contact": contact,
        "conversation": conversation,
        "message": message,
        "schema": {"id": str(schema), "version": 1},
        "lead_agent": await seed_agent(connection, tenant, capabilities),
        "survey_agent": await seed_agent(connection, tenant, []),
    }


async def admit_callback(
    connection: AsyncConnection, fixture: dict, *, unlocked: bool
) -> tuple[UUID, UUID]:
    """The only cross-channel voice path: a secured callback for the conversation.

    Verification itself is covered by test_voice_handoff_verification; here the
    state is set directly so the lead boundary is what is under test.
    """

    handoff = (
        await execute(
            connection,
            "INSERT INTO automation.handoffs(tenant_id,contact_id,conversation_id,"
            "source_channel,reason_safe,idempotency_key) VALUES(:tenant,:contact,"
            ":conversation,'whatsapp','Secure voice continuation',:key) RETURNING id",
            tenant=fixture["tenant"],
            contact=fixture["contact"],
            conversation=fixture["conversation"],
            key=f"voice-lead-{uuid4()}",
        )
    ).scalar_one()
    session = await seed_call(
        connection,
        fixture["tenant"],
        fixture["contact"],
        conversation=fixture["conversation"],
        handoff=handoff,
    )
    await execute(
        connection,
        "SELECT set_config('app.current_tenant',:tenant,true)",
        tenant=str(fixture["tenant"]),
    )
    await execute(
        connection,
        "SELECT platform.initialize_voice_identity_verification(:session,:handoff)",
        session=session,
        handoff=handoff,
    )
    if unlocked:
        await execute(
            connection,
            "UPDATE automation.voice_identity_verifications SET state='context_unlocked',"
            "verified_at=clock_timestamp(),context_unlocked_at=clock_timestamp() "
            "WHERE tenant_id=:tenant AND session_id=:session",
            tenant=fixture["tenant"],
            session=session,
        )
    return session, handoff


def call_context(fixture: dict, session: UUID, **links: UUID | None) -> CallContext:
    return CallContext(
        call_id=f"voice-lead-{session}",
        session_id=session,
        tenant_id=fixture["tenant"],
        flow_id=uuid4(),
        direction=Direction.OUTBOUND,
        contact_id=fixture["contact"],
        source_conversation_id=links.get("conversation"),
        handoff_id=links.get("handoff"),
    )
