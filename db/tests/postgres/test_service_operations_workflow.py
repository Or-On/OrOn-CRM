"""Configured field operations and traceable phone intake against PostgreSQL.

Every scenario runs as the real runtime role that performs it (voice agent,
messaging worker, web user) inside a rolled-back transaction, with fictional
data only.
"""

# ruff: noqa: E501 -- SQL fixture statements are clearer unwrapped.
from __future__ import annotations

import json
from dataclasses import dataclass
from uuid import UUID, uuid4

import asyncpg
import pytest

from db.tests.postgres.test_field_service import _auth_session, _tenant

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]

CALLER = "+972502345678"
ON_CALL = "+972501111111"

FULL_POLICY = {
    "version": 1,
    "requiredIntakeFields": ["customerName", "faultDescription", "urgency"],
    "photoPolicy": "requested",
    "selfAssignmentEnabled": True,
    "requiredReportFields": ["diagnosis", "workPerformed"],
    "inquiry": {"openOnFirstContact": True},
    "whatsappFollowUp": {
        "enabled": True,
        "trigger": "call_ended",
        "requestPhoto": True,
        "consent": "in_call_agreement",
    },
    "emergency": {
        "enabled": True,
        "label": "Red call",
        "manualRedCall": True,
        "transferTo": ON_CALL,
        "fallback": "urgent_followup",
    },
    "preparation": {
        "enabled": True,
        "requireAcknowledgement": True,
        "instructions": "Bring the spare board.",
        "checklist": [
            {"key": "spare_board", "label": "Spare board", "required": True},
            {"key": "ladder", "label": "Ladder", "required": False},
        ],
    },
    "attachmentCategories": [{"key": "rcg", "label": "RCG", "accept": ["pdf", "image"]}],
    "evidence": {"beforePhotoRequired": True, "afterPhotoRequired": True},
}
LEGACY_LIKE_POLICY = {
    "version": 1,
    "requiredIntakeFields": ["faultDescription"],
    "photoPolicy": "optional",
    "selfAssignmentEnabled": False,
    "requiredReportFields": ["diagnosis"],
}


@dataclass(frozen=True)
class ServiceTenant:
    tenant_id: UUID
    owner_id: UUID
    contact_id: UUID
    identity_id: UUID
    agent_id: UUID
    channel_id: UUID


async def _as(pg: asyncpg.Connection, db_role: str, tenant: UUID, **settings: str) -> None:
    await pg.execute("RESET ROLE")
    await pg.execute(f"SET LOCAL ROLE {db_role}")
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    for key in ("current_user", "current_role", "current_session"):
        await pg.execute(
            "SELECT set_config($1,$2,true)", f"app.{key}", settings.get(key.split("_", 1)[1], "")
        )


async def _migrator(pg: asyncpg.Connection) -> None:
    await pg.execute("RESET ROLE")


async def _service_tenant(pg: asyncpg.Connection, name: str, policy: dict) -> ServiceTenant:
    base = await _tenant(pg, name, enabled=True)
    for feature in ("contacts", "agents", "voice", "whatsapp", "tickets", "technicians"):
        await pg.execute(
            "INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,granted_at) "
            "VALUES($1,$2,true,true,CURRENT_TIMESTAMP) ON CONFLICT (tenant_id,feature_key) "
            "DO UPDATE SET available=true,enabled=true",
            base.tenant_id,
            feature,
        )
    await pg.execute(
        "UPDATE platform.tenant_feature_entitlements SET enabled=true,configuration=$2::jsonb "
        "WHERE tenant_id=$1 AND feature_key='field_service'",
        base.tenant_id,
        json.dumps({"workflow": policy}),
    )
    await pg.execute(
        "INSERT INTO crm.tenant_settings(tenant_id,locale,business_name) VALUES($1,'he',$2) "
        "ON CONFLICT (tenant_id) DO UPDATE SET locale='he',business_name=EXCLUDED.business_name",
        base.tenant_id,
        f"{name} service",
    )
    identity = await pg.fetchval(
        "INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,"
        "validation_status,is_primary) VALUES($1,$2,'phone',$3,'valid',true) RETURNING id",
        base.tenant_id,
        base.contact_id,
        CALLER,
    )
    profile = await pg.fetchval(
        "INSERT INTO agents.agent_profiles(tenant_id,name) VALUES($1,'Fictional intake agent') RETURNING id",
        base.tenant_id,
    )
    agent = await pg.fetchval(
        "INSERT INTO agents.agent_profile_versions(tenant_id,agent_profile_id,version,system_prompt,"
        "locale,channel_capabilities,tool_permissions,validation_status,published_at) "
        "VALUES($1,$2,1,'Fictional agent.','he',ARRAY['voice','whatsapp'],'[\"service.intake\"]'::jsonb,"
        "'valid',CURRENT_TIMESTAMP) RETURNING id",
        base.tenant_id,
        profile,
    )
    channel = await pg.fetchval(
        "INSERT INTO messaging.channels(tenant_id,kind,provider,display_address,status,provider_account_id) "
        "VALUES($1,'whatsapp','simulator','Fixture WhatsApp','active',$2) RETURNING id",
        base.tenant_id,
        f"sim-{base.tenant_id}",
    )
    return ServiceTenant(base.tenant_id, base.user_id, base.contact_id, identity, agent, channel)


async def _call(pg: asyncpg.Connection, tenant: ServiceTenant, *, contact: bool = True) -> UUID:
    session = uuid4()
    await pg.execute(
        "INSERT INTO public.sessions(session_id,tenant_id,contact_id,provider,direction,room,status,flow_id) "
        "VALUES($1,$2,$3,'livekit','inbound',$4,'started',$5)",
        session,
        tenant.tenant_id,
        tenant.contact_id if contact else None,
        f"inbound-{session}",
        uuid4(),
    )
    await pg.execute(
        "INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,payload) "
        "VALUES($1,$2,0,'voice.agent.binding.v1',$3::jsonb)",
        tenant.tenant_id,
        session,
        json.dumps(
            {
                "agent_version_id": str(tenant.agent_id),
                "caller_identity_id": str(tenant.identity_id) if contact else None,
            }
        ),
    )
    return session


async def _end_call(pg: asyncpg.Connection, session: UUID) -> None:
    await _migrator(pg)
    await pg.execute(
        "UPDATE public.sessions SET status='ended',ended_at=CURRENT_TIMESTAMP WHERE session_id=$1",
        session,
    )


async def _json(pg: asyncpg.Connection, sql: str, *args) -> dict:
    return json.loads(await pg.fetchval(sql, *args))


async def _ticket_for(pg: asyncpg.Connection, session: UUID) -> asyncpg.Record:
    await _migrator(pg)
    return await pg.fetchrow(
        "SELECT * FROM support.tickets WHERE attachment_key=$1", f"voice-session:{session}"
    )


async def _events(pg: asyncpg.Connection, ticket: UUID) -> list[asyncpg.Record]:
    await _migrator(pg)
    return await pg.fetch(
        "SELECT kind,summary_safe,evidence FROM support.ticket_events WHERE ticket_id=$1 ORDER BY sequence",
        ticket,
    )


# --- configuration ------------------------------------------------------------


async def test_workflow_policy_validation_accepts_extensions_and_rejects_malformed(pg):
    valid = await pg.fetchval(
        "SELECT service.validate_workflow_policy($1::jsonb)", json.dumps(FULL_POLICY)
    )
    assert valid is True
    assert await pg.fetchval(
        "SELECT service.validate_workflow_policy($1::jsonb)", json.dumps(LEGACY_LIKE_POLICY)
    )
    broken = [
        {**FULL_POLICY, "unknown": True},
        {**FULL_POLICY, "emergency": {**FULL_POLICY["emergency"], "transferTo": "0501234567"}},
        {**FULL_POLICY, "emergency": {**FULL_POLICY["emergency"], "label": ""}},
        {
            **FULL_POLICY,
            "whatsappFollowUp": {**FULL_POLICY["whatsappFollowUp"], "templateName": "x"},
        },
        {
            **FULL_POLICY,
            "attachmentCategories": [{"key": "before_photo", "label": "x", "accept": ["pdf"]}],
        },
        {
            **FULL_POLICY,
            "attachmentCategories": [{"key": "rcg", "label": "RCG", "accept": ["exe"]}],
        },
        {
            **FULL_POLICY,
            "preparation": {**FULL_POLICY["preparation"], "checklist": [{"key": "A B"}]},
        },
        {**FULL_POLICY, "evidence": {"beforePhotoRequired": "yes", "afterPhotoRequired": True}},
        {**FULL_POLICY, "requiredIntakeFields": ["urgency"]},
    ]
    for policy in broken:
        assert (
            await pg.fetchval(
                "SELECT service.validate_workflow_policy($1::jsonb)", json.dumps(policy)
            )
            is False
        ), policy


async def test_routing_contact_is_redacted_from_every_policy_reader(pg):
    tenant = await _service_tenant(pg, "Redaction fixture", FULL_POLICY)
    case = await pg.fetchval(
        "INSERT INTO service.cases(tenant_id,reference,customer_contact_id,title,fault_description) "
        "VALUES($1,'FS-RED-1',$2,'Fault','Details') RETURNING id",
        tenant.tenant_id,
        tenant.contact_id,
    )
    pinned = await pg.fetchval("SELECT workflow_policy::text FROM service.cases WHERE id=$1", case)
    assert ON_CALL not in pinned and '"label": "Red call"' in pinned
    await _as(pg, "platform_web", tenant.tenant_id, user=str(tenant.owner_id), role="technician")
    assert ON_CALL not in await pg.fetchval("SELECT service.current_workflow_policy()::text")
    await _migrator(pg)
    session = await _call(pg, tenant)
    await _as(pg, "platform_voice", tenant.tenant_id)
    context = await pg.fetchval("SELECT service.voice_intake_context($1)::text", session)
    assert ON_CALL not in context
    # The number is released to the voice runtime only after a real escalation.
    assert await pg.fetchval("SELECT service.voice_emergency_transfer($1)", session) is None


# --- phone inquiry ----------------------------------------------------------------


async def test_phone_inquiry_is_visible_before_details_or_photo_and_settles_when_the_call_drops(pg):
    tenant = await _service_tenant(pg, "Inquiry fixture", FULL_POLICY)
    session = await _call(pg, tenant)
    await _as(pg, "platform_voice", tenant.tenant_id)
    opened = await _json(pg, "SELECT service.open_voice_inquiry($1)", session)
    again = await _json(pg, "SELECT service.open_voice_inquiry($1)", session)
    assert opened["status"] == "open" and again["ticketId"] == opened["ticketId"]
    # Visible to staff in the inquiry inbox before any detail or photo exists.
    await _as(pg, "platform_web", tenant.tenant_id, user=str(tenant.owner_id), role="owner")
    visible = await pg.fetchrow(
        "SELECT subject,stage,source_channel,intake_draft_id FROM support.tickets"
    )
    assert visible["subject"] == "פנייה טלפונית" and visible["source_channel"] == "voice"
    assert str(visible["intake_draft_id"]) == opened["intakeId"]
    await _as(pg, "platform_voice", tenant.tenant_id)
    await pg.fetchval(
        "SELECT service.capture_service_intake($1,$2::jsonb,false)",
        session,
        json.dumps({"faultDescription": "המקרר בחדר הקירור לא מקרר", "urgency": "high"}),
    )
    ticket = await _ticket_for(pg, session)
    assert ticket["subject"] == "המקרר בחדר הקירור לא מקרר" and ticket["priority"] == "high"
    await _end_call(pg, session)
    ticket = await _ticket_for(pg, session)
    assert ticket["stage"] == "awaiting_human" and ticket["handling_mode"] == "human"
    assert ticket["next_action"] == "complete_intake"
    events = await _events(pg, ticket["id"])
    assert [event["kind"] for event in events] == ["opened", "customer_update", "call_outcome"]
    # Sanitized: field names, never the caller's words.
    assert "המקרר" not in events[1]["summary_safe"]
    assert "before the service details were confirmed" in events[2]["summary_safe"]


async def test_confirmation_links_the_early_inquiry_to_one_case_without_a_second_ticket(pg):
    tenant = await _service_tenant(pg, "Confirmation fixture", FULL_POLICY)
    session = await _call(pg, tenant)
    await _as(pg, "platform_voice", tenant.tenant_id)
    await pg.fetchval("SELECT service.open_voice_inquiry($1)", session)
    receipt = await _json(
        pg,
        "SELECT service.capture_service_intake($1,$2::jsonb,true)",
        session,
        json.dumps(
            {"customerName": "Fixture", "faultDescription": "Printer is blank", "urgency": "urgent"}
        ),
    )
    assert receipt["caseId"] and receipt["ticketId"]
    await _migrator(pg)
    tickets = await pg.fetch(
        "SELECT id,service_case_id,priority FROM support.tickets WHERE tenant_id=$1",
        tenant.tenant_id,
    )
    assert len(tickets) == 1 and str(tickets[0]["service_case_id"]) == receipt["caseId"]
    assert (
        await pg.fetchval("SELECT priority FROM service.cases WHERE id=$1", UUID(receipt["caseId"]))
        == "urgent"
    )


async def test_unconfigured_tenant_keeps_confirmation_only_tickets(pg):
    tenant = await _service_tenant(pg, "Unconfigured fixture", LEGACY_LIKE_POLICY)
    session = await _call(pg, tenant)
    await _as(pg, "platform_voice", tenant.tenant_id)
    assert (await _json(pg, "SELECT service.open_voice_inquiry($1)", session))[
        "status"
    ] == "not_configured"
    await pg.fetchval(
        "SELECT service.capture_service_intake($1,$2::jsonb,false)",
        session,
        json.dumps({"faultDescription": "Door is stuck"}),
    )
    assert await _ticket_for(pg, session) is None
    await _as(pg, "platform_voice", tenant.tenant_id)
    assert (await _json(pg, "SELECT service.request_intake_followup($1,true)", session))[
        "status"
    ] == "unavailable"
    assert (await _json(pg, "SELECT service.escalate_voice_emergency($1,'fire')", session))[
        "status"
    ] == "not_configured"
    await _end_call(pg, session)
    assert await _ticket_for(pg, session) is None
    # Agent actions are refused once the call has ended.
    await _as(pg, "platform_voice", tenant.tenant_id)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval(
                "SELECT service.capture_service_intake($1,'{}'::jsonb,false)", session
            )


# --- WhatsApp follow-up -------------------------------------------------------------


async def test_followup_consent_is_recorded_and_the_job_is_enqueued_once_at_call_end(pg):
    tenant = await _service_tenant(pg, "Follow-up fixture", FULL_POLICY)
    session = await _call(pg, tenant)
    await _as(pg, "platform_voice", tenant.tenant_id)
    await pg.fetchval("SELECT service.open_voice_inquiry($1)", session)
    result = await _json(pg, "SELECT service.request_intake_followup($1,true)", session)
    assert result["status"] == "deferred"
    await _migrator(pg)
    assert (
        await pg.fetchval(
            "SELECT whatsapp_consent FROM crm.contacts WHERE id=$1", tenant.contact_id
        )
        == "granted"
    )
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM audit.records WHERE action='crm.contact.whatsapp_consent_granted' AND target_id=$1",
            tenant.contact_id,
        )
        == 1
    )
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM ops.jobs WHERE tenant_id=$1 AND job_type='field_service.intake_followup'",
            tenant.tenant_id,
        )
        == 0
    )
    await _end_call(pg, session)
    await pg.execute(
        "UPDATE public.sessions SET ended_at=CURRENT_TIMESTAMP WHERE session_id=$1", session
    )
    jobs = await pg.fetch(
        "SELECT payload FROM ops.jobs WHERE tenant_id=$1 AND job_type='field_service.intake_followup'",
        tenant.tenant_id,
    )
    assert len(jobs) == 1 and json.loads(jobs[0]["payload"])["cause"] == "call_ended"


async def test_revoked_consent_blocks_the_followup_and_is_visible(pg):
    tenant = await _service_tenant(pg, "Revoked fixture", FULL_POLICY)
    await pg.execute(
        "UPDATE crm.contacts SET whatsapp_consent='revoked',whatsapp_opted_out_at=CURRENT_TIMESTAMP WHERE id=$1",
        tenant.contact_id,
    )
    session = await _call(pg, tenant)
    await _as(pg, "platform_voice", tenant.tenant_id)
    await pg.fetchval("SELECT service.open_voice_inquiry($1)", session)
    result = await _json(pg, "SELECT service.request_intake_followup($1,true)", session)
    assert result == {
        "status": "unavailable",
        "reason": "consent_revoked",
        "intakeId": result["intakeId"],
    }
    await _end_call(pg, session)
    assert (
        await pg.fetchval(
            "SELECT followup_status FROM service.intake_drafts WHERE source_session_id=$1", session
        )
        == "blocked_consent"
    )
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM ops.jobs WHERE tenant_id=$1 AND job_type='field_service.intake_followup'",
            tenant.tenant_id,
        )
        == 0
    )


async def test_followup_recipient_is_only_the_pinned_caller_number(pg):
    tenant = await _service_tenant(pg, "Recipient fixture", FULL_POLICY)
    session = await _call(pg, tenant)
    await _as(pg, "platform_voice", tenant.tenant_id)
    opened = await _json(pg, "SELECT service.open_voice_inquiry($1)", session)
    intake = UUID(opened["intakeId"])
    await _as(pg, "platform_messaging", tenant.tenant_id, role="service")
    prepared = await _json(pg, "SELECT service.prepare_intake_followup_recipient($1)", intake)
    assert prepared["status"] == "ready" and prepared["recipientAddress"] == CALLER
    conversation, identity = UUID(prepared["conversationId"]), UUID(prepared["recipientIdentityId"])
    assert await pg.fetchval(
        "SELECT service.verified_followup_recipient($1,$2,$3,$4)",
        intake,
        conversation,
        identity,
        CALLER,
    )
    assert not await pg.fetchval(
        "SELECT service.verified_followup_recipient($1,$2,$3,$4)",
        intake,
        conversation,
        identity,
        "+972509999999",
    )
    await _migrator(pg)
    other = await pg.fetchval(
        "INSERT INTO crm.contacts(tenant_id,name) VALUES($1,'Someone else') RETURNING id",
        tenant.tenant_id,
    )
    other_identity = await pg.fetchval(
        "INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,validation_status) "
        "VALUES($1,$2,'whatsapp','+972508888888','valid') RETURNING id",
        tenant.tenant_id,
        other,
    )
    await _as(pg, "platform_messaging", tenant.tenant_id, role="service")
    assert not await pg.fetchval(
        "SELECT service.verified_followup_recipient($1,$2,$3,$4)",
        intake,
        conversation,
        other_identity,
        "+972508888888",
    )


async def test_caller_number_owned_by_another_contact_is_a_conflict(pg):
    tenant = await _service_tenant(pg, "Conflict fixture", FULL_POLICY)
    other = await pg.fetchval(
        "INSERT INTO crm.contacts(tenant_id,name) VALUES($1,'Existing WhatsApp owner') RETURNING id",
        tenant.tenant_id,
    )
    await pg.execute(
        "INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,validation_status) "
        "VALUES($1,$2,'whatsapp',$3,'valid')",
        tenant.tenant_id,
        other,
        CALLER,
    )
    session = await _call(pg, tenant)
    await _as(pg, "platform_voice", tenant.tenant_id)
    intake = UUID((await _json(pg, "SELECT service.open_voice_inquiry($1)", session))["intakeId"])
    await _as(pg, "platform_messaging", tenant.tenant_id, role="service")
    assert (await _json(pg, "SELECT service.prepare_intake_followup_recipient($1)", intake))[
        "status"
    ] == "recipient_conflict"


async def _admit_followup(pg, tenant: ServiceTenant, session: UUID) -> tuple[UUID, UUID, UUID]:
    await _as(pg, "platform_voice", tenant.tenant_id)
    intake = UUID((await _json(pg, "SELECT service.open_voice_inquiry($1)", session))["intakeId"])
    await _as(pg, "platform_messaging", tenant.tenant_id, role="service")
    prepared = await _json(pg, "SELECT service.prepare_intake_followup_recipient($1)", intake)
    conversation = UUID(prepared["conversationId"])
    await _migrator(pg)
    outbound = await pg.fetchval(
        "INSERT INTO messaging.messages(tenant_id,conversation_id,direction,sender_type,content_type,"
        "content_text,provider,provider_message_id,status) VALUES($1,$2,'outbound','agent','text',"
        "'summary','simulator',$3,'sent') RETURNING id",
        tenant.tenant_id,
        conversation,
        f"wamid.{uuid4()}",
    )
    await _as(pg, "platform_messaging", tenant.tenant_id, role="service")
    await pg.execute(
        "SELECT service.record_intake_followup($1,'admitted',$2,NULL)", intake, outbound
    )
    return intake, conversation, outbound


async def _inbound(
    pg, tenant: ServiceTenant, conversation: UUID, *, reply_to=None, content="text", obj=None
):
    await _migrator(pg)
    return await pg.fetchval(
        "INSERT INTO messaging.messages(tenant_id,conversation_id,direction,sender_type,sender_contact_id,"
        "content_type,content_text,object_id,provider,provider_message_id,reply_to_message_id,status) "
        "VALUES($1,$2,'inbound','contact',$3,$4,'reply',$5,'simulator',$6,$7,'received') RETURNING id",
        tenant.tenant_id,
        conversation,
        tenant.contact_id,
        content,
        obj,
        f"wamid.in.{uuid4()}",
        reply_to,
    )


async def _image(
    pg,
    tenant: ServiceTenant,
    owner_type: str,
    owner_id: UUID,
    *,
    status="available",
    content_type="image/jpeg",
):
    await _migrator(pg)
    return await pg.fetchval(
        "INSERT INTO objects.object_metadata(tenant_id,owner_type,owner_id,category,content_type,byte_size,"
        "checksum,storage_backend,storage_key,status) VALUES($1,$2,$3,'evidence',$4,100,$5,'local',$6,$7) RETURNING id",
        tenant.tenant_id,
        owner_type,
        owner_id,
        content_type,
        uuid4().hex,
        f"fixture/{uuid4()}",
        status,
    )


async def test_reply_text_and_photo_attach_to_the_same_inquiry(pg):
    tenant = await _service_tenant(pg, "Reply fixture", FULL_POLICY)
    session = await _call(pg, tenant)
    intake, conversation, outbound = await _admit_followup(pg, tenant, session)
    ticket = (await _ticket_for(pg, session))["id"]
    assert (await _ticket_for(pg, session))["stage"] == "awaiting_customer"
    reply = await _inbound(pg, tenant, conversation, reply_to=outbound)
    message_for_photo = uuid4()
    photo_object = await _image(pg, tenant, "message", message_for_photo)
    await pg.execute(
        "INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,sender_contact_id,"
        "content_type,object_id,provider,provider_message_id,status) VALUES($1,$2,$3,'inbound','contact',$4,"
        "'image',$5,'simulator',$6,'received')",
        message_for_photo,
        tenant.tenant_id,
        conversation,
        tenant.contact_id,
        photo_object,
        f"wamid.photo.{uuid4()}",
    )
    linked = {
        row[0]
        for row in await pg.fetch(
            "SELECT message_id FROM service.intake_messages WHERE intake_draft_id=$1", intake
        )
    }
    assert {outbound, reply, message_for_photo} <= linked
    draft = await pg.fetchrow(
        "SELECT customer_replied_at,customer_media_received_at FROM service.intake_drafts WHERE id=$1",
        intake,
    )
    assert (
        draft["customer_replied_at"] is not None and draft["customer_media_received_at"] is not None
    )
    kinds = [event["kind"] for event in await _events(pg, ticket)]
    assert kinds.count("customer_message") == 2
    assert (await _ticket_for(pg, session))["stage"] == "awaiting_human"
    # Confirmation after the photo arrived carries it onto the case as the
    # customer's fault photo, never as technician before-evidence.
    await _as(pg, "platform_voice", tenant.tenant_id)
    receipt = await _json(
        pg,
        "SELECT service.capture_service_intake($1,$2::jsonb,true)",
        session,
        json.dumps(
            {"customerName": "Fixture", "faultDescription": "Screen cracked", "urgency": "normal"}
        ),
    )
    await _migrator(pg)
    categories = await pg.fetch(
        "SELECT category FROM service.report_attachments WHERE case_id=$1", UUID(receipt["caseId"])
    )
    assert [row["category"] for row in categories] == ["customer_photo"]


async def test_ambiguous_reply_is_held_for_staff_and_linked_explicitly(pg):
    tenant = await _service_tenant(pg, "Ambiguity fixture", FULL_POLICY)
    first_session, second_session = await _call(pg, tenant), await _call(pg, tenant)
    first, conversation, _ = await _admit_followup(pg, tenant, first_session)
    second, second_conversation, _ = await _admit_followup(pg, tenant, second_session)
    assert conversation == second_conversation
    message = await _inbound(pg, tenant, conversation)
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM service.intake_messages WHERE message_id=$1", message
        )
        == 0
    )
    candidates = await pg.fetchval(
        "SELECT candidate_intake_ids FROM service.followup_triage WHERE message_id=$1", message
    )
    assert set(candidates) == {first, second}
    await _as(pg, "platform_web", tenant.tenant_id, user=str(tenant.owner_id), role="viewer")
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval("SELECT service.resolve_followup_triage($1,$2)", message, first)
    await _as(pg, "platform_web", tenant.tenant_id, user=str(tenant.owner_id), role="owner")
    with pytest.raises(asyncpg.InvalidParameterValueError):
        async with pg.transaction():
            await pg.fetchval("SELECT service.resolve_followup_triage($1,$2)", message, uuid4())
    await pg.fetchval("SELECT service.resolve_followup_triage($1,$2)", message, second)
    await _migrator(pg)
    assert (
        await pg.fetchval(
            "SELECT intake_draft_id FROM service.intake_messages WHERE message_id=$1", message
        )
        == second
    )


# --- emergency -----------------------------------------------------------------------


async def test_voice_emergency_marks_the_inquiry_urgent_and_records_every_outcome(pg):
    tenant = await _service_tenant(pg, "Emergency fixture", FULL_POLICY)
    session = await _call(pg, tenant)
    await _as(pg, "platform_voice", tenant.tenant_id)
    assert await pg.fetchval("SELECT service.voice_emergency_transfer($1)", session) is None
    escalated = await _json(
        pg, "SELECT service.escalate_voice_emergency($1,$2)", session, "Water is flooding the store"
    )
    assert escalated["status"] == "escalated" and escalated["transferAvailable"] is True
    assert ON_CALL not in json.dumps(escalated)
    assert await pg.fetchval("SELECT service.voice_emergency_transfer($1)", session) == ON_CALL
    await pg.fetchval("SELECT service.record_voice_escalation($1,'transfer_failed')", session)
    await pg.fetchval(
        "SELECT service.record_voice_escalation($1,'fallback_urgent_followup')", session
    )
    ticket = await _ticket_for(pg, session)
    assert ticket["priority"] == "urgent" and ticket["emergency_source"] == "voice"
    assert ticket["next_action"] == "urgent_callback" and ticket["stage"] == "awaiting_human"
    escalations = [e for e in await _events(pg, ticket["id"]) if e["kind"] == "escalation"]
    outcomes = [json.loads(e["evidence"]).get("escalation") for e in escalations]
    assert outcomes == ["marked", "transfer_failed", "fallback_urgent_followup"]
    assert not any(
        "answered" in e["summary_safe"] and "not confirmed" not in e["summary_safe"]
        for e in escalations
    )
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM messaging.notifications WHERE reference_id=$1 AND type='support.emergency'",
            ticket["id"],
        )
        >= 1
    )


async def test_emergency_without_an_identifiable_caller_still_escalates(pg):
    tenant = await _service_tenant(pg, "Anonymous emergency fixture", FULL_POLICY)
    session = await _call(pg, tenant, contact=False)
    await _as(pg, "platform_voice", tenant.tenant_id)
    result = await _json(
        pg, "SELECT service.escalate_voice_emergency($1,'Fire in the kitchen')", session
    )
    assert result["status"] == "escalated_without_inquiry"
    assert await pg.fetchval("SELECT service.voice_emergency_transfer($1)", session) == ON_CALL
    assert (
        await pg.fetchval(
            "SELECT service.record_voice_escalation($1,'transfer_initiated')", session
        )
        == 0
    )
    await _migrator(pg)
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM messaging.notifications WHERE reference_type='voice_session' AND reference_id=$1",
            session,
        )
        >= 1
    )
    kinds = [
        row[0]
        for row in await pg.fetch(
            "SELECT event_type FROM public.session_events WHERE session_id=$1 ORDER BY sequence",
            session,
        )
    ]
    assert kinds[-2:] == ["voice.emergency.v1", "voice.escalation.v1"]


async def test_manual_red_call_requires_a_dispatcher_and_the_tenant_setting(pg):
    tenant = await _service_tenant(pg, "Red call fixture", FULL_POLICY)
    case = await pg.fetchval(
        "INSERT INTO service.cases(tenant_id,reference,customer_contact_id,title,fault_description,created_by_user_id) "
        "VALUES($1,'FS-RED-2',$2,'Owner call','Compressor down',$3) RETURNING id",
        tenant.tenant_id,
        tenant.contact_id,
        tenant.owner_id,
    )
    ticket = await pg.fetchval("SELECT id FROM support.tickets WHERE service_case_id=$1", case)
    await _as(pg, "platform_web", tenant.tenant_id, user=str(tenant.owner_id), role="technician")
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval(
                "SELECT support.mark_ticket_emergency($1,'Compressor down','manual')", ticket
            )
    await _as(pg, "platform_web", tenant.tenant_id, user=str(tenant.owner_id), role="owner")
    marked = await _json(
        pg, "SELECT support.mark_ticket_emergency($1,'Compressor down in store','manual')", ticket
    )
    assert marked["created"] is True
    again = await _json(pg, "SELECT support.mark_ticket_emergency($1,'again','manual')", ticket)
    assert again["created"] is False
    await _migrator(pg)
    row = await pg.fetchrow(
        "SELECT priority,emergency_source,emergency_marked_by_user_id FROM support.tickets WHERE id=$1",
        ticket,
    )
    assert row["priority"] == "urgent" and row["emergency_source"] == "manual"
    assert row["emergency_marked_by_user_id"] == tenant.owner_id
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM audit.records WHERE action='support.ticket.emergency_marked' AND target_id=$1",
            ticket,
        )
        == 1
    )
    disabled = {**FULL_POLICY, "emergency": {**FULL_POLICY["emergency"], "manualRedCall": False}}
    await pg.execute(
        "UPDATE platform.tenant_feature_entitlements SET configuration=$2::jsonb WHERE tenant_id=$1 AND feature_key='field_service'",
        tenant.tenant_id,
        json.dumps({"workflow": disabled}),
    )
    other = await pg.fetchval(
        "INSERT INTO service.cases(tenant_id,reference,customer_contact_id,title,fault_description) "
        "VALUES($1,'FS-RED-3',$2,'Second','Details') RETURNING id",
        tenant.tenant_id,
        tenant.contact_id,
    )
    other_ticket = await pg.fetchval(
        "SELECT id FROM support.tickets WHERE service_case_id=$1", other
    )
    await _as(pg, "platform_web", tenant.tenant_id, user=str(tenant.owner_id), role="owner")
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval("SELECT support.mark_ticket_emergency($1,'x','manual')", other_ticket)


# --- technician workflow ---------------------------------------------------------------


async def _technician_visit(pg, tenant: ServiceTenant, *, policy_case: bool = True):
    user = uuid4()
    await pg.execute(
        "INSERT INTO users(id,email,status) VALUES($1,$2,'active')", user, f"{user}@example.test"
    )
    await pg.execute(
        "INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'technician')",
        user,
        tenant.tenant_id,
    )
    technician = await pg.fetchval(
        "INSERT INTO service.technicians(tenant_id,linked_user_id,full_name) VALUES($1,$2,'Fixture technician') RETURNING id",
        tenant.tenant_id,
        user,
    )
    session = await _auth_session(pg, user, tenant.tenant_id, f"tech-{user}")
    case = await pg.fetchval(
        "INSERT INTO service.cases(tenant_id,reference,customer_contact_id,title,fault_description,assigned_technician_id) "
        "VALUES($1,$2,$3,'Freezer','Not cooling',$4) RETURNING id",
        tenant.tenant_id,
        f"FS-T-{uuid4().hex[:6]}",
        tenant.contact_id,
        technician,
    )
    visit = await pg.fetchval(
        "INSERT INTO service.visits(tenant_id,case_id,technician_id,visit_number) VALUES($1,$2,$3,1) RETURNING id",
        tenant.tenant_id,
        case,
        technician,
    )
    return user, technician, session, case, visit


async def _as_technician(pg, tenant: ServiceTenant, user: UUID, session: UUID) -> None:
    await _as(
        pg,
        "platform_web",
        tenant.tenant_id,
        user=str(user),
        role="technician",
        session=str(session),
    )


async def _arrive(pg, tenant: ServiceTenant, case: UUID, visit: UUID, technician: UUID) -> None:
    signature = await _image(pg, tenant, "service_case", case, content_type="image/png")
    await pg.execute(
        "INSERT INTO service.report_attachments(tenant_id,case_id,visit_id,object_id,category,source) "
        "VALUES($1,$2,$3,$4,'arrival_signature','technician')",
        tenant.tenant_id,
        case,
        visit,
        signature,
    )
    await pg.execute(
        "UPDATE service.visits SET status='arrived',arrival_at=clock_timestamp(),arrival_signature_object_id=$2,"
        "arrival_identity=$3::jsonb WHERE id=$1",
        visit,
        signature,
        json.dumps({"technicianId": str(technician)}),
    )


async def _evidence(
    pg, tenant: ServiceTenant, case: UUID, visit: UUID, category: str, **kwargs
) -> UUID:
    obj = await _image(pg, tenant, "service_case", case, **kwargs)
    await pg.execute(
        "INSERT INTO service.report_attachments(tenant_id,case_id,visit_id,object_id,category,source,processing_status) "
        "VALUES($1,$2,$3,$4,$5,'technician',$6)",
        tenant.tenant_id,
        case,
        visit,
        obj,
        category,
        "available" if kwargs.get("status", "available") == "available" else "pending",
    )
    return obj


async def test_before_and_after_photos_gate_every_server_transition(pg):
    tenant = await _service_tenant(pg, "Evidence fixture", FULL_POLICY)
    user, technician, session, case, visit = await _technician_visit(pg, tenant)
    await _as_technician(pg, tenant, user, session)
    with pytest.raises(asyncpg.CheckViolationError, match="ARRIVAL_REQUIRED"):
        async with pg.transaction():
            await pg.fetchval("SELECT service.record_visit_event($1,'work_started','r1')", visit)
    await _migrator(pg)
    await _arrive(pg, tenant, case, visit, technician)
    # A customer photo and a pending upload never count as technician evidence.
    customer_photo = await _image(pg, tenant, "service_case", case)
    await pg.execute(
        "INSERT INTO service.report_attachments(tenant_id,case_id,object_id,category,source) "
        "VALUES($1,$2,$3,'customer_photo','customer')",
        tenant.tenant_id,
        case,
        customer_photo,
    )
    await _evidence(pg, tenant, case, visit, "before_photo", status="pending")
    await _as_technician(pg, tenant, user, session)
    with pytest.raises(asyncpg.CheckViolationError, match="BEFORE_PHOTO_REQUIRED"):
        async with pg.transaction():
            await pg.fetchval("SELECT service.record_visit_event($1,'work_started','r2')", visit)
    # Direct API/bulk paths hit the same gate.
    await _as(pg, "platform_web", tenant.tenant_id, user=str(tenant.owner_id), role="owner")
    with pytest.raises(asyncpg.CheckViolationError, match="BEFORE_PHOTO_REQUIRED"):
        async with pg.transaction():
            await pg.execute("UPDATE service.cases SET status='in_progress' WHERE id=$1", case)
    # The correction flag is not a bypass for runtime roles.
    with pytest.raises(asyncpg.CheckViolationError, match="BEFORE_PHOTO_REQUIRED"):
        async with pg.transaction():
            await pg.execute("SELECT set_config('service.visit_time_correction','on',true)")
            await pg.execute(
                "UPDATE service.visits SET work_started_at=clock_timestamp() WHERE id=$1", visit
            )
    await _migrator(pg)
    before = await _evidence(pg, tenant, case, visit, "before_photo")
    # The same stored object can never also be the after photo.
    with pytest.raises(asyncpg.UniqueViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO service.report_attachments(tenant_id,case_id,visit_id,object_id,category,source) "
                "VALUES($1,$2,$3,$4,'after_photo','technician')",
                tenant.tenant_id,
                case,
                visit,
                before,
            )
    await _as_technician(pg, tenant, user, session)
    started = await _json(pg, "SELECT service.record_visit_event($1,'work_started','r3')", visit)
    assert started["workStartedAt"] and started["changed"] is True
    await _migrator(pg)
    assert await pg.fetchval("SELECT status FROM service.cases WHERE id=$1", case) == "in_progress"
    await _as_technician(pg, tenant, user, session)
    with pytest.raises(asyncpg.CheckViolationError, match="AFTER_PHOTO_REQUIRED"):
        async with pg.transaction():
            await pg.fetchval("SELECT service.record_visit_event($1,'work_completed','r4')", visit)
    await _as(pg, "platform_web", tenant.tenant_id, user=str(tenant.owner_id), role="owner")
    with pytest.raises(asyncpg.CheckViolationError, match="AFTER_PHOTO_REQUIRED"):
        async with pg.transaction():
            await pg.execute("UPDATE service.cases SET status='completed' WHERE id=$1", case)
    await _migrator(pg)
    report = await pg.fetchval(
        "INSERT INTO service.reports(tenant_id,case_id,visit_id) VALUES($1,$2,$3) RETURNING id",
        tenant.tenant_id,
        case,
        visit,
    )
    revision = await pg.fetchval(
        "INSERT INTO service.report_revisions(tenant_id,report_id,version) VALUES($1,$2,1) RETURNING id",
        tenant.tenant_id,
        report,
    )
    await _as(pg, "platform_web", tenant.tenant_id, user=str(tenant.owner_id), role="owner")
    with pytest.raises(asyncpg.CheckViolationError, match="AFTER_PHOTO_REQUIRED"):
        async with pg.transaction():
            await pg.execute(
                "UPDATE service.report_revisions SET status='finalized',finalized_at=clock_timestamp(),"
                "branding_snapshot='{}'::jsonb WHERE id=$1",
                revision,
            )
    await _migrator(pg)
    await _evidence(pg, tenant, case, visit, "after_photo")
    await _as_technician(pg, tenant, user, session)
    completed = await _json(
        pg, "SELECT service.record_visit_event($1,'work_completed','r5')", visit
    )
    assert completed["workCompletedAt"] >= completed["workStartedAt"]
    await _as(pg, "platform_web", tenant.tenant_id, user=str(tenant.owner_id), role="owner")
    await pg.execute("UPDATE service.cases SET status='completed' WHERE id=$1", case)


async def test_customer_photo_cannot_be_relabelled_as_technician_evidence(pg):
    tenant = await _service_tenant(pg, "Relabel fixture", FULL_POLICY)
    _user, _technician, _session, case, visit = await _technician_visit(pg, tenant)
    obj = await _image(pg, tenant, "service_case", case)
    with pytest.raises(asyncpg.CheckViolationError, match="technician uploads on a visit"):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO service.report_attachments(tenant_id,case_id,visit_id,object_id,category,source) "
                "VALUES($1,$2,$3,$4,'before_photo','customer')",
                tenant.tenant_id,
                case,
                visit,
                obj,
            )


async def test_cases_opened_before_evidence_was_enabled_keep_their_rules(pg):
    tenant = await _service_tenant(pg, "Pinned evidence fixture", LEGACY_LIKE_POLICY)
    _user, _technician, _session, case, _visit = await _technician_visit(pg, tenant)
    await pg.execute(
        "UPDATE platform.tenant_feature_entitlements SET configuration=$2::jsonb WHERE tenant_id=$1 AND feature_key='field_service'",
        tenant.tenant_id,
        json.dumps({"workflow": FULL_POLICY}),
    )
    await _as(pg, "platform_web", tenant.tenant_id, user=str(tenant.owner_id), role="owner")
    await pg.execute("UPDATE service.cases SET status='in_progress' WHERE id=$1", case)
    await pg.execute("UPDATE service.cases SET status='completed' WHERE id=$1", case)


async def test_arrival_is_explicit_and_corrections_are_audited_by_managers_only(pg):
    tenant = await _service_tenant(pg, "Timeline fixture", FULL_POLICY)
    user, technician, session, case, visit = await _technician_visit(pg, tenant)
    await _migrator(pg)
    assert await pg.fetchval("SELECT arrival_at FROM service.visits WHERE id=$1", visit) is None
    await _arrive(pg, tenant, case, visit, technician)
    original = await pg.fetchval("SELECT arrival_at FROM service.visits WHERE id=$1", visit)
    await _as_technician(pg, tenant, user, session)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval(
                "SELECT service.correct_visit_time($1,'arrival_at',now()-interval '1 hour','wrong')",
                visit,
            )
    with pytest.raises(asyncpg.ObjectNotInPrerequisiteStateError):
        async with pg.transaction():
            await pg.execute(
                "UPDATE service.visits SET arrival_at=now()-interval '2 hours' WHERE id=$1", visit
            )
    await _as(pg, "platform_web", tenant.tenant_id, user=str(tenant.owner_id), role="owner")
    corrected = await pg.fetchval(
        "SELECT service.correct_visit_time($1,'arrival_at',$2,'Technician signed late at the door')",
        visit,
        original.replace(microsecond=0),
    )
    await _migrator(pg)
    row = await pg.fetchrow("SELECT * FROM service.visit_time_corrections WHERE id=$1", corrected)
    assert row["previous_value"] == original and row["corrected_by_user_id"] == tenant.owner_id
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM audit.records WHERE action='field_service.visit.time_corrected' AND target_id=$1",
            visit,
        )
        == 1
    )


async def test_preparation_acknowledgement_is_required_once_until_requirements_change(pg):
    tenant = await _service_tenant(pg, "Preparation fixture", FULL_POLICY)
    user, _technician, session, case, visit = await _technician_visit(pg, tenant)
    await _as_technician(pg, tenant, user, session)
    preparation = await _json(pg, "SELECT service.visit_preparation($1)", visit)
    assert preparation["enabled"] and not preparation["acknowledged"]
    assert [item["key"] for item in preparation["checklist"]] == ["spare_board", "ladder"]
    with pytest.raises(asyncpg.CheckViolationError, match="PREPARATION_ACKNOWLEDGEMENT_REQUIRED"):
        async with pg.transaction():
            await pg.fetchval("SELECT service.record_visit_event($1,'en_route','p1')", visit)
    with pytest.raises(asyncpg.CheckViolationError, match="PREPARATION_CHECKLIST_INCOMPLETE"):
        async with pg.transaction():
            await pg.fetchval(
                "SELECT service.acknowledge_visit_preparation($1,$2,'[\"ladder\"]'::jsonb)",
                visit,
                preparation["requirementsHash"],
            )
    acknowledged = await _json(
        pg,
        "SELECT service.acknowledge_visit_preparation($1,$2,'[\"spare_board\"]'::jsonb)",
        visit,
        preparation["requirementsHash"],
    )
    assert acknowledged["acknowledged"] is True
    assert (await _json(pg, "SELECT service.record_visit_event($1,'en_route','p2')", visit))[
        "enRouteAt"
    ]
    await _migrator(pg)
    await pg.execute(
        "UPDATE service.cases SET fault_description='Not cooling and leaking' WHERE id=$1", case
    )
    await _as_technician(pg, tenant, user, session)
    assert (await _json(pg, "SELECT service.visit_preparation($1)", visit))["acknowledged"] is False


async def test_configured_document_types_accept_only_their_file_types(pg):
    tenant = await _service_tenant(pg, "RCG fixture", FULL_POLICY)
    _user, _technician, _session, case, visit = await _technician_visit(pg, tenant)
    pdf = await _image(pg, tenant, "service_case", case, content_type="application/pdf")
    await pg.execute(
        "INSERT INTO service.report_attachments(tenant_id,case_id,visit_id,object_id,category,document_type,source) "
        "VALUES($1,$2,$3,$4,'tenant_document','rcg','technician')",
        tenant.tenant_id,
        case,
        visit,
        pdf,
    )
    unknown = await _image(pg, tenant, "service_case", case, content_type="application/pdf")
    with pytest.raises(asyncpg.CheckViolationError, match="not configured"):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO service.report_attachments(tenant_id,case_id,object_id,category,document_type,source) "
                "VALUES($1,$2,$3,'tenant_document','invoice','technician')",
                tenant.tenant_id,
                case,
                unknown,
            )


# --- tenancy and rollout ----------------------------------------------------------------


async def test_second_tenant_enables_the_same_capabilities_by_configuration_and_stays_isolated(pg):
    first = await _service_tenant(pg, "First configured tenant", FULL_POLICY)
    second_policy = {
        **FULL_POLICY,
        "emergency": {
            **FULL_POLICY["emergency"],
            "label": "Priority one",
            "transferTo": "+972507777777",
        },
        "attachmentCategories": [{"key": "site_form", "label": "Site form", "accept": ["pdf"]}],
    }
    second = await _service_tenant(pg, "Second configured tenant", second_policy)
    first_call, second_call = await _call(pg, first), await _call(pg, second)
    await _as(pg, "platform_voice", first.tenant_id)
    assert (await _json(pg, "SELECT service.open_voice_inquiry($1)", first_call))[
        "status"
    ] == "open"
    await _as(pg, "platform_voice", second.tenant_id)
    assert (await _json(pg, "SELECT service.open_voice_inquiry($1)", second_call))[
        "status"
    ] == "open"
    escalated = await _json(
        pg, "SELECT service.escalate_voice_emergency($1,'Sparks from the panel')", second_call
    )
    assert escalated["status"] == "escalated"
    assert (
        await pg.fetchval("SELECT service.voice_emergency_transfer($1)", second_call)
        == "+972507777777"
    )
    # A voice runtime bound to one tenant cannot act on another tenant's call.
    with pytest.raises(asyncpg.PostgresError):
        async with pg.transaction():
            await pg.fetchval("SELECT service.open_voice_inquiry($1)", first_call)
    await _as(pg, "platform_web", second.tenant_id, user=str(second.owner_id), role="owner")
    assert await pg.fetchval("SELECT count(*) FROM support.tickets") == 1
    assert await pg.fetchval("SELECT count(*) FROM service.followup_triage") == 0


async def test_quarantined_is_a_durable_inbound_event_disposition(pg):
    event = await pg.fetchval(
        "INSERT INTO ops.inbound_events(provider,provider_account_id,provider_event_id,event_type,payload,status) "
        "VALUES('livekit','default',$1,'participant_joined','{}'::jsonb,'quarantined') RETURNING id",
        f"evt-{uuid4()}",
    )
    assert event is not None


# --- regression: inbound admission ------------------------------------------------------


async def test_inbound_caller_admission_resolves_contacts_instead_of_failing(pg):
    """0f7b3c9d2a61 called pg_catalog.coalesce, which does not exist, so this
    raised for every inbound caller and the call was hung up at admission."""

    tenant = await _service_tenant(pg, "Admission fixture", LEGACY_LIKE_POLICY)
    await _as(pg, "platform_voice", tenant.tenant_id)
    existing = await pg.fetchval("SELECT platform.resolve_voice_caller_contact($1)", CALLER)
    assert existing == tenant.contact_id
    created = await pg.fetchval("SELECT platform.resolve_voice_caller_contact('+972503333333')")
    again = await pg.fetchval("SELECT platform.resolve_voice_caller_contact('+972503333333')")
    assert created is not None and created == again
    assert await pg.fetchval("SELECT platform.resolve_voice_caller_contact('not-a-number')") is None


async def test_voice_ticket_action_opens_one_ticket(pg):
    tenant = await _service_tenant(pg, "Voice ticket fixture", LEGACY_LIKE_POLICY)
    session = await _call(pg, tenant)
    await _as(pg, "platform_voice", tenant.tenant_id)
    first = await _json(
        pg, "SELECT support.open_ticket_from_voice_session($1,'Fault','Printer blank')", session
    )
    second = await _json(
        pg, "SELECT support.open_ticket_from_voice_session($1,'Fault','Printer blank')", session
    )
    assert first["created"] is True and second == {**first, "created": False}
