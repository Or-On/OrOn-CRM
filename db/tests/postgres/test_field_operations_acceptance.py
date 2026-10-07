# ruff: noqa: E501 -- SQL fixture statements are clearer unwrapped.
"""Consolidated acceptance pass for configured field operations.

The real voice persistence adapter and intake tools run against migrated
PostgreSQL as the runtime roles. The ProTouch configuration file drives one
tenant, a relabelled copy drives a second tenant (configuration only, no code
change), and a third tenant without the settings keeps its previous behaviour.
Model behaviour is scripted: this exercises the platform boundaries, not a
provider. No real telephony, WhatsApp or LLM is contacted.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
from pathlib import Path
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from dispatcher_runtime.persistence import (
    AgentPostgresSessions,
    PostgresVoiceRuntime,
    _async_database_url,
)
from oron_agent.lead_capture import AcceptedTurns
from oron_agent.scope_policy import approved_response, classify_turn, validate_output
from oron_agent.service_intake import build_voice_service_intake
from oron_common import CallContext, Direction
from oron_sessions import SessionStatus
from oron_sessions.crypto import LocalFieldCipher
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]

ROOT = Path(__file__).parents[3]
PROTOUCH = json.loads(
    (ROOT / "infra" / "tenant-configurations" / "protouch.field-operations.json").read_text(
        encoding="utf-8"
    )
)["featureConfiguration"]["field_service"]["workflow"]
LEGACY = {
    "version": 1,
    "requiredIntakeFields": ["faultDescription"],
    "photoPolicy": "requested",
    "selfAssignmentEnabled": False,
    "requiredReportFields": ["diagnosis"],
}


async def _sql(connection, statement: str, **parameters):
    return await connection.execute(text(statement), parameters)


async def _tenant(connection, name: str, policy: dict, caller: str) -> dict:
    tenant, owner, contact = uuid4(), uuid4(), uuid4()
    await _sql(connection, "RESET ROLE")
    await _sql(
        connection,
        "INSERT INTO tenants(id,name,slug) VALUES(:t,:n,:s)",
        t=tenant,
        n=name,
        s=f"acceptance-{tenant}",
    )
    await _sql(
        connection,
        "INSERT INTO users(id,email,status) VALUES(:u,:e,'active')",
        u=owner,
        e=f"{owner}@example.test",
    )
    await _sql(
        connection,
        "INSERT INTO memberships(user_id,tenant_id,role) VALUES(:u,:t,'owner')",
        u=owner,
        t=tenant,
    )
    for feature in (
        "contacts",
        "agents",
        "voice",
        "whatsapp",
        "tickets",
        "technicians",
        "field_service",
    ):
        await _sql(
            connection,
            "INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,granted_at) "
            "VALUES(:t,:f,true,true,now()) ON CONFLICT (tenant_id,feature_key) DO UPDATE SET available=true,enabled=true",
            t=tenant,
            f=feature,
        )
    await _sql(
        connection,
        "UPDATE platform.tenant_feature_entitlements SET configuration=CAST(:c AS jsonb) WHERE tenant_id=:t AND feature_key='field_service'",
        t=tenant,
        c=json.dumps({"workflow": policy}),
    )
    await _sql(
        connection,
        "INSERT INTO service.tenant_configuration(tenant_id,enabled) VALUES(:t,true)",
        t=tenant,
    )
    await _sql(
        connection,
        "INSERT INTO crm.tenant_settings(tenant_id,locale,business_name,timezone) VALUES(:t,'he',:n,'Asia/Jerusalem') "
        "ON CONFLICT (tenant_id) DO UPDATE SET locale='he',business_name=EXCLUDED.business_name,timezone='Asia/Jerusalem'",
        t=tenant,
        n=name,
    )
    # An existing customer; a brand-new number is resolved at admission.
    await _sql(
        connection,
        "INSERT INTO crm.contacts(id,tenant_id,name) VALUES(:c,:t,:p)",
        c=contact,
        t=tenant,
        p=caller,
    )
    await _sql(
        connection,
        "INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,validation_status,is_primary) "
        "VALUES(:t,:c,'phone',:p,'valid',true)",
        t=tenant,
        c=contact,
        p=caller,
    )
    profile = (
        await _sql(
            connection,
            "INSERT INTO agents.agent_profiles(tenant_id,name) VALUES(:t,'Fictional agent') RETURNING id",
            t=tenant,
        )
    ).scalar_one()
    agent = (
        await _sql(
            connection,
            "INSERT INTO agents.agent_profile_versions(tenant_id,agent_profile_id,version,system_prompt,locale,"
            "channel_capabilities,tool_permissions,validation_status,published_at) VALUES(:t,:p,1,'Fictional.','he',"
            "ARRAY['voice','whatsapp'],'[\"service.intake\"]'::jsonb,'valid',now()) RETURNING id",
            t=tenant,
            p=profile,
        )
    ).scalar_one()
    return {
        "tenant": tenant,
        "owner": owner,
        "contact": contact,
        "agent": UUID(str(agent)),
        "name": name,
    }


@pytest_asyncio.fixture
async def acceptance(postgres_url):
    engine = create_async_engine(_async_database_url(postgres_url))
    async with engine.connect() as connection:
        transaction = await connection.begin()
        try:
            runtime = object.__new__(PostgresVoiceRuntime)
            runtime._sessionmaker = async_sessionmaker(
                bind=connection,
                class_=AsyncSession,
                expire_on_commit=False,
                join_transaction_mode="create_savepoint",
            )
            runtime._cipher = LocalFieldCipher(b"\x01" * 32)
            runtime._blind_index_key = base64.b64decode(base64.b64encode(b"\x02" * 32))
            yield connection, runtime, AgentPostgresSessions(runtime)
        finally:
            await transaction.rollback()
    await engine.dispose()


async def _call(connection, runtime, sessions, tenant: dict, caller: str):
    context = CallContext(
        call_id=f"acceptance-{uuid4()}",
        tenant_id=tenant["tenant"],
        flow_id=uuid4(),
        direction=Direction.INBOUND,
        from_number=caller,
        to_number="+972399999999",
    )
    await _sql(connection, "RESET ROLE")
    await _sql(connection, "SET LOCAL ROLE platform_voice")
    # Admission resolves the caller to a contact (the 0f7b3c9d2a61 regression).
    assert await runtime.begin(
        context, room=context.call_id, idempotency_key=f"acceptance:{context.call_id}"
    )
    assert context.contact_id is not None
    await runtime.pin_voice_agent(context, tenant["agent"])
    turns = AcceptedTurns()
    tools = await build_voice_service_intake(
        sessions, context, {"capabilities": ["service.intake"]}, turns, {}
    )
    assert tools is not None
    return context, turns, tools


async def _as_web(connection, tenant: dict, role: str = "owner") -> None:
    await _sql(connection, "RESET ROLE")
    await _sql(connection, "SET LOCAL ROLE platform_web")
    await _sql(
        connection,
        "SELECT set_config('app.current_tenant',:t,true),set_config('app.current_user',:u,true),set_config('app.current_role',:r,true)",
        t=str(tenant["tenant"]),
        u=str(tenant["owner"]),
        r=role,
    )


async def test_configured_field_operations_end_to_end(acceptance):
    connection, runtime, sessions = acceptance
    protouch = await _tenant(connection, "ProTouch acceptance fixture", PROTOUCH, "+972502345671")
    second_policy = copy.deepcopy(PROTOUCH)
    second_policy["emergency"]["label"] = "Priority one"
    second_policy["attachmentCategories"] = [
        {"key": "site_form", "label": "Site form", "accept": ["pdf"]}
    ]
    second = await _tenant(
        connection, "Second field company fixture", second_policy, "+972502345672"
    )
    legacy = await _tenant(connection, "Unconfigured fixture", LEGACY, "+972502345673")

    # 1. Scope: the observed failure is answered by the server and never spoken.
    decision = classify_turn("איזה מודל אתה?")
    assert decision.route == "identity"
    assert protouch["name"] in approved_response("identity", "he", protouch["name"])
    assert not validate_output("אני מודל שפה גדול שאומן על ידי גוגל").allowed

    # 2. Phone admission creates no inquiry/case before explicit web submission.
    context, turns, tools = await _call(connection, runtime, sessions, protouch, "+972502345671")
    await _as_web(connection, protouch)
    inbox = (
        (await _sql(connection, "SELECT subject,source_channel,stage FROM support.tickets"))
        .mappings()
        .all()
    )
    assert inbox == []

    # 3. Short call: the caller is identified and handed the WhatsApp form.
    await _sql(connection, "RESET ROLE")
    await _sql(connection, "SET LOCAL ROLE platform_voice")
    turns.accept()
    assert tools.form_mode
    assert tools.tool_names[:2] == ("capture_service_intake", "send_whatsapp_service_form")
    saved = await tools.capture({"fields": {"customerName": "דנה"}, "confirmed": False})
    assert saved["ok"] and saved["receipt"]["missingFields"] == ["faultDescription"]
    incomplete = await tools.send_form({"customerAgreed": True})
    assert not incomplete["ok"] and incomplete["missingFields"] == ["faultDescription"]
    saved = await tools.capture(
        {"fields": {"faultDescription": "המסך נדלק ואז כבה"}, "confirmed": False}
    )
    assert saved["ok"] and saved["receipt"]["missingFields"] == []
    forbidden = await tools.capture(
        {"fields": {"serviceAddress": "רחוב לדוגמה"}, "confirmed": True}
    )
    assert not forbidden["ok"]
    # Saved facts cannot substitute for a later, explicit caller agreement.
    assert (await tools.send_form({"customerAgreed": True}))["needsConsent"]
    tools.consent_node({"name": "support", "task_messages": [], "functions": []})
    turns.accept()
    tools.record_caller_turn("כן בבקשה")
    # No approved template and no open WhatsApp window: nothing is promised,
    # and no more phone intake or delivery/staff-notification claims are made.
    refused = await tools.send_form({"customerAgreed": True})
    assert not refused["ok"] and "request could not be completed" in refused["error"]
    assert "Do not collect address" in refused["error"]
    # The caller wrote to the business on WhatsApp within the last day.
    await _sql(connection, "RESET ROLE")
    channel = (
        await _sql(
            connection,
            "INSERT INTO messaging.channels(tenant_id,kind,provider,provider_account_id,status) "
            "VALUES(:t,'whatsapp','meta',:a,'active') RETURNING id",
            t=protouch["tenant"],
            a=f"acceptance-{uuid4()}",
        )
    ).scalar_one()
    await _sql(
        connection,
        "INSERT INTO messaging.conversations(tenant_id,channel_id,contact_id,status,"
        "customer_service_window_expires_at) VALUES(:t,:c,:p,'open',now()+interval '20 hours')",
        t=protouch["tenant"],
        c=channel,
        p=protouch["contact"],
    )
    await _sql(connection, "SET LOCAL ROLE platform_voice")
    sent = await tools.send_form({"customerAgreed": True})
    assert sent["ok"] and sent["receipt"]["status"] == "queued"
    assert "הבקשה לשליחת הקישור נקלטה" in sent["closing"]
    assert "תיפתח אחרי מילוי הטופס" in sent["closing"]
    await _sql(connection, "RESET ROLE")
    await _sql(connection, "SET LOCAL ROLE platform_voice")
    assert await runtime.finalize(context.session_id, context.tenant_id, status=SessionStatus.ENDED)
    await _sql(connection, "RESET ROLE")
    assert (
        await _sql(
            connection,
            "SELECT count(*) FROM support.tickets WHERE tenant_id=:t",
            t=protouch["tenant"],
        )
    ).scalar_one() == 0
    assert (
        await _sql(
            connection,
            "SELECT count(*) FROM service.cases WHERE tenant_id=:t",
            t=protouch["tenant"],
        )
    ).scalar_one() == 0
    intake = (
        (
            await _sql(
                connection,
                "SELECT id,collected_fields,followup_status FROM service.intake_drafts "
                "WHERE source_session_id=:s",
                s=context.session_id,
            )
        )
        .mappings()
        .one()
    )
    assert intake["followup_status"] == "queued"
    assert intake["collected_fields"]["customerName"] == "דנה"
    assert intake["collected_fields"]["faultDescription"] == "המסך נדלק ואז כבה"
    assert "serviceAddress" not in intake["collected_fields"]
    assert (
        await _sql(
            connection,
            "SELECT count(*) FROM ops.jobs WHERE tenant_id=:t AND job_type='field_service.intake_followup'",
            t=protouch["tenant"],
        )
    ).scalar_one() == 1

    # The worker's database boundary issues the private capability and records
    # admission only. Delivery is scripted; no provider is contacted in this test.
    token_hash = hashlib.sha256(uuid4().bytes + uuid4().bytes).hexdigest()
    await _sql(connection, "SET LOCAL ROLE platform_messaging")
    assert (
        await _sql(
            connection,
            "SELECT service.issue_digital_intake_form(:i,:h)",
            i=intake["id"],
            h=token_hash,
        )
    ).scalar_one() == protouch["tenant"]
    await _sql(
        connection, "SELECT service.record_intake_followup(:i,'admitted',NULL,NULL)", i=intake["id"]
    )
    await _as_web(connection, protouch)
    form = (
        await _sql(connection, "SELECT service.read_digital_intake_form(:h)", h=token_hash)
    ).scalar_one()
    assert form["customerName"] == "דנה" and form["faultDescription"] == "המסך נדלק ואז כבה"
    assert form["submitted"] is False
    with pytest.raises(Exception, match="complete and confirm"):
        async with connection.begin_nested():
            await _sql(
                connection,
                "SELECT service.submit_digital_intake_form(:h,'דנה','רחוב לדוגמה 12','המסך נדלק ואז כבה',false,'[]')",
                h=token_hash,
            )
    assert (await _sql(connection, "SELECT count(*) FROM service.cases")).scalar_one() == 0
    submitted = (
        await _sql(
            connection,
            "SELECT service.submit_digital_intake_form(:h,'דנה','רחוב לדוגמה 12','המסך נדלק ואז כבה',true,'[]')",
            h=token_hash,
        )
    ).scalar_one()
    assert submitted["created"] is True
    repeated = (
        await _sql(
            connection,
            "SELECT service.submit_digital_intake_form(:h,'דנה','רחוב לדוגמה 12','המסך נדלק ואז כבה',true,'[]')",
            h=token_hash,
        )
    ).scalar_one()
    assert repeated == {"created": False, "reference": submitted["reference"]}
    case = (
        await _sql(
            connection, "SELECT id FROM service.cases WHERE intake_draft_id=:i", i=intake["id"]
        )
    ).scalar_one()
    assert (
        await _sql(
            connection, "SELECT count(*) FROM support.tickets WHERE service_case_id=:c", c=case
        )
    ).scalar_one() == 1
    assert (
        await _sql(
            connection,
            "SELECT count(*) FROM service.case_calls WHERE case_id=:c AND session_id=:s",
            c=case,
            s=context.session_id,
        )
    ).scalar_one() == 1

    # 4. A second phone call cannot use emergency handling to bypass form submit.
    emergency_context, emergency_turns, emergency_tools = await _call(
        connection, runtime, sessions, protouch, "+972502345671"
    )
    emergency_turns.accept()
    spoken: list[str] = []

    async def speak(line: str) -> None:
        spoken.append(line)

    assert "escalate_emergency" not in emergency_tools.tool_names
    result = await emergency_tools.escalate({"reason": "הצפה בחדר הקירור"}, speak)
    assert not result["ok"] and "No case or escalation may be opened by phone" in result["error"]
    assert spoken == []
    await _sql(connection, "RESET ROLE")
    assert (
        await _sql(
            connection,
            "SELECT count(*) FROM support.tickets WHERE attachment_key=:k",
            k=f"voice-session:{emergency_context.session_id}",
        )
    ).scalar_one() == 0

    # 5. Manual red call by the owner on the customer's submitted case.
    await _as_web(connection, protouch)
    red_ticket = (
        await _sql(connection, "SELECT id FROM support.tickets WHERE service_case_id=:c", c=case)
    ).scalar_one()
    receipt = (
        await _sql(
            connection,
            "SELECT support.mark_ticket_emergency(:t,'Compressor down in store','manual')",
            t=red_ticket,
        )
    ).scalar_one()
    assert receipt["created"] is True

    # 6. Technician: preparation, arrival, before/after evidence gates.
    await _sql(connection, "RESET ROLE")
    user = uuid4()
    await _sql(
        connection,
        "INSERT INTO users(id,email,status) VALUES(:u,:e,'active')",
        u=user,
        e=f"{user}@example.test",
    )
    await _sql(
        connection,
        "INSERT INTO memberships(user_id,tenant_id,role) VALUES(:u,:t,'technician')",
        u=user,
        t=protouch["tenant"],
    )
    technician = (
        await _sql(
            connection,
            "INSERT INTO service.technicians(tenant_id,linked_user_id,full_name) VALUES(:t,:u,'Tech') RETURNING id",
            t=protouch["tenant"],
            u=user,
        )
    ).scalar_one()
    visit = (
        await _sql(
            connection,
            "INSERT INTO service.visits(tenant_id,case_id,technician_id,visit_number) VALUES(:t,:c,:x,1) RETURNING id",
            t=protouch["tenant"],
            c=case,
            x=technician,
        )
    ).scalar_one()
    session = (
        await _sql(
            connection,
            "SELECT platform.auth_create_session(:u,:t,:a,:b,43200,now()+interval '12 hours',now()+interval '7 days',NULL,NULL,'acceptance')",
            u=user,
            t=protouch["tenant"],
            a=uuid4().bytes + uuid4().bytes,
            b=uuid4().bytes + uuid4().bytes,
        )
    ).scalar_one()

    async def as_technician():
        await _sql(connection, "RESET ROLE")
        await _sql(connection, "SET LOCAL ROLE platform_web")
        await _sql(
            connection,
            "SELECT set_config('app.current_tenant',:t,true),set_config('app.current_user',:u,true),"
            "set_config('app.current_role','technician',true),set_config('app.current_session',:s,true)",
            t=str(protouch["tenant"]),
            u=str(user),
            s=str(session),
        )

    await as_technician()
    preparation = (
        await _sql(connection, "SELECT service.visit_preparation(:v)", v=visit)
    ).scalar_one()
    assert (
        preparation["enabled"]
        and preparation["checklist"][0]["label"] == "קראתי את פרטי הקריאה והתקלה"
    )
    await _sql(
        connection,
        "SELECT service.acknowledge_visit_preparation(:v,:h,CAST(:c AS jsonb))",
        v=visit,
        h=preparation["requirementsHash"],
        c=json.dumps(["case_reviewed", "parts_loaded", "tools_loaded"]),
    )
    assert (
        await _sql(connection, "SELECT service.record_visit_event(:v,'en_route','a1')", v=visit)
    ).scalar_one()["enRouteAt"]

    async def image(owner_case, content_type="image/jpeg"):
        await _sql(connection, "RESET ROLE")
        return (
            await _sql(
                connection,
                "INSERT INTO objects.object_metadata(tenant_id,owner_type,owner_id,category,content_type,byte_size,checksum,storage_backend,storage_key,status) "
                "VALUES(:t,'service_case',:c,'evidence',:ct,10,:h,'local',:k,'available') RETURNING id",
                t=protouch["tenant"],
                c=owner_case,
                ct=content_type,
                h=uuid4().hex,
                k=f"acceptance/{uuid4()}",
            )
        ).scalar_one()

    signature = await image(case, "image/png")
    await _sql(
        connection,
        "INSERT INTO service.report_attachments(tenant_id,case_id,visit_id,object_id,category,source) VALUES(:t,:c,:v,:o,'arrival_signature','technician')",
        t=protouch["tenant"],
        c=case,
        v=visit,
        o=signature,
    )
    await _sql(
        connection,
        "UPDATE service.visits SET status='arrived',arrival_at=clock_timestamp(),arrival_signature_object_id=:o,arrival_identity='{}'::jsonb WHERE id=:v",
        o=signature,
        v=visit,
    )
    await as_technician()
    with pytest.raises(Exception, match="BEFORE_PHOTO_REQUIRED"):
        async with connection.begin_nested():
            await _sql(
                connection, "SELECT service.record_visit_event(:v,'work_started','a2')", v=visit
            )
    before = await image(case)
    await _sql(
        connection,
        "INSERT INTO service.report_attachments(tenant_id,case_id,visit_id,object_id,category,source) VALUES(:t,:c,:v,:o,'before_photo','technician')",
        t=protouch["tenant"],
        c=case,
        v=visit,
        o=before,
    )
    rcg = await image(case, "application/pdf")
    await _sql(
        connection, "SELECT set_config('app.current_tenant',:t,true)", t=str(protouch["tenant"])
    )
    await _sql(
        connection,
        "INSERT INTO service.report_attachments(tenant_id,case_id,visit_id,object_id,category,document_type,source) VALUES(:t,:c,:v,:o,'tenant_document','rcg','technician')",
        t=protouch["tenant"],
        c=case,
        v=visit,
        o=rcg,
    )
    await as_technician()
    await _sql(connection, "SELECT service.record_visit_event(:v,'work_started','a3')", v=visit)
    with pytest.raises(Exception, match="AFTER_PHOTO_REQUIRED"):
        async with connection.begin_nested():
            await _sql(
                connection, "SELECT service.record_visit_event(:v,'work_completed','a4')", v=visit
            )
    after = await image(case)
    await _sql(
        connection,
        "INSERT INTO service.report_attachments(tenant_id,case_id,visit_id,object_id,category,source) VALUES(:t,:c,:v,:o,'after_photo','technician')",
        t=protouch["tenant"],
        c=case,
        v=visit,
        o=after,
    )
    await as_technician()
    times = (
        await _sql(
            connection, "SELECT service.record_visit_event(:v,'work_completed','a5')", v=visit
        )
    ).scalar_one()
    assert times["workCompletedAt"] and times["arrivalAt"] and times["enRouteAt"]

    # 7. The second tenant runs the same capabilities from its own configuration.
    second_context, second_turns, second_tools = await _call(
        connection, runtime, sessions, second, "+972502345672"
    )
    await _sql(connection, "RESET ROLE")
    assert (
        await _sql(
            connection,
            "SELECT count(*) FROM support.tickets WHERE attachment_key=:k",
            k=f"voice-session:{second_context.session_id}",
        )
    ).scalar_one() == 0
    assert second_tools.form_mode and "escalate_emergency" not in second_tools.tool_names

    # 8. The unconfigured tenant keeps its behaviour: no early inquiry, no emergency tool.
    legacy_context, _legacy_turns, legacy_tools = await _call(
        connection, runtime, sessions, legacy, "+972502345673"
    )
    await _sql(connection, "RESET ROLE")
    assert (
        await _sql(
            connection,
            "SELECT count(*) FROM support.tickets WHERE tenant_id=:t",
            t=legacy["tenant"],
        )
    ).scalar_one() == 0
    assert "escalate_emergency" not in legacy_tools.tool_names

    # 9. Tenant isolation: ProTouch staff see none of the other tenants' inquiries.
    await _as_web(connection, protouch)
    tenants_seen = (
        (await _sql(connection, "SELECT DISTINCT tenant_id FROM support.tickets")).scalars().all()
    )
    assert tenants_seen == [protouch["tenant"]]
