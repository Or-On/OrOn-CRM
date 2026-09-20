"""Assignment boundaries and immutable per-incident workflow policy."""

import json
from uuid import uuid4

import asyncpg
import pytest

from db.tests.postgres.test_field_service import _auth_session, _tenant

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]

POLICY = {
    "version": 1,
    "requiredIntakeFields": ["faultDescription"],
    "photoPolicy": "requested",
    "selfAssignmentEnabled": True,
    "requiredReportFields": ["diagnosis", "workPerformed"],
}


async def test_available_queue_is_limited_and_claim_is_exclusive_and_audited(
    pg: asyncpg.Connection,
):
    tenant = await _tenant(pg, "Dispatch fixture", enabled=True)
    await pg.execute(
        "UPDATE platform.tenant_feature_entitlements SET enabled=true,configuration=$2::jsonb "
        "WHERE tenant_id=$1 AND feature_key='field_service'",
        tenant.tenant_id,
        json.dumps({"workflow": POLICY}),
    )
    identities = []
    for number in range(2):
        user = uuid4()
        await pg.execute(
            "INSERT INTO users(id,email,status) VALUES($1,$2,'active')",
            user,
            f"{user}@example.test",
        )
        await pg.execute(
            "INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'technician')",
            user,
            tenant.tenant_id,
        )
        technician = await pg.fetchval(
            "INSERT INTO service.technicians(tenant_id,linked_user_id,full_name) "
            "VALUES($1,$2,$3) RETURNING id",
            tenant.tenant_id,
            user,
            f"Fixture tech {number}",
        )
        session = await _auth_session(pg, user, tenant.tenant_id, f"dispatch-{number}")
        identities.append((user, technician, session))
    case = await pg.fetchval(
        "INSERT INTO service.cases"
        "(tenant_id,reference,customer_contact_id,title,fault_description) "
        "VALUES($1,'FS-QUEUE-1',$2,'Printer','Blank paper') RETURNING id",
        tenant.tenant_id,
        tenant.contact_id,
    )
    await pg.execute("SET LOCAL ROLE platform_web")

    async def as_tech(index):
        user, _, session = identities[index]
        await pg.execute(
            "SELECT set_config('app.current_tenant',$1,true),"
            "set_config('app.current_user',$2,true),"
            "set_config('app.current_role','technician',true),"
            "set_config('app.current_session',$3,true)",
            str(tenant.tenant_id),
            str(user),
            str(session),
        )

    await as_tech(0)
    assert await pg.fetchval("SELECT count(*) FROM service.cases") == 0
    queue = [
        json.loads(row[0])
        for row in await pg.fetch("SELECT * FROM service.list_assignment_queue('available')")
    ]
    assert len(queue) == 1 and queue[0]["id"] == str(case)
    assert "customerPhone" not in queue[0]
    first = json.loads(await pg.fetchval("SELECT service.assign_case($1,NULL,NULL)", case))
    repeat = json.loads(await pg.fetchval("SELECT service.assign_case($1,NULL,NULL)", case))
    assert first == repeat
    assert first["technicianId"] == str(identities[0][1])
    assert await pg.fetchval("SELECT count(*) FROM service.cases") == 1
    await as_tech(1)
    assert await pg.fetch("SELECT * FROM service.list_assignment_queue('available')") == []
    assert await pg.fetchval("SELECT count(*) FROM service.cases") == 0
    with pytest.raises(asyncpg.SerializationError):
        async with pg.transaction():
            await pg.fetchval("SELECT service.assign_case($1,NULL,NULL)", case)
    await pg.execute("RESET ROLE")
    assert await pg.fetchval("SELECT count(*) FROM service.visits WHERE case_id=$1", case) == 1
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM audit.records WHERE target_id=$1 "
            "AND action='field_service.case.claimed'",
            case,
        )
        == 1
    )
    assert (
        await pg.fetchval("SELECT count(*) FROM support.tickets WHERE service_case_id=$1", case)
        == 1
    )


async def test_incident_policy_stays_pinned_and_workflow_validation_is_strict(
    pg: asyncpg.Connection,
):
    tenant = await _tenant(pg, "Pinned policy fixture", enabled=True)
    await pg.execute(
        "UPDATE platform.tenant_feature_entitlements SET enabled=true,configuration=$2::jsonb "
        "WHERE tenant_id=$1 AND feature_key='field_service'",
        tenant.tenant_id,
        json.dumps({"workflow": POLICY}),
    )
    case = await pg.fetchval(
        "INSERT INTO service.cases"
        "(tenant_id,reference,customer_contact_id,title,fault_description) "
        "VALUES($1,'FS-PIN-1',$2,'Fault','Fault details') RETURNING id",
        tenant.tenant_id,
        tenant.contact_id,
    )
    old_draft = await pg.fetchval(
        "INSERT INTO service.intake_drafts(tenant_id,reporting_contact_id,correlation_key) "
        "VALUES($1,$2,'legacy-snapshot') RETURNING id",
        tenant.tenant_id,
        tenant.contact_id,
    )
    # A pre-migration draft has no policy snapshot, regardless of the new tenant policy.
    await pg.execute("UPDATE service.intake_drafts SET workflow_policy=NULL WHERE id=$1", old_draft)
    old_case_policy = json.loads(
        await pg.fetchval(
            "INSERT INTO service.cases(tenant_id,reference,customer_contact_id,title,"
            "fault_description,intake_draft_id) "
            "VALUES($1,'FS-LEGACY-PIN',$2,'Legacy fault','Legacy details',$3) "
            "RETURNING workflow_policy",
            tenant.tenant_id,
            tenant.contact_id,
            old_draft,
        )
    )
    assert "nationalId" in old_case_policy["requiredIntakeFields"]
    assert "arrivalSignature" in old_case_policy["requiredReportFields"]
    await pg.execute(
        "UPDATE platform.tenant_feature_entitlements SET configuration='{}' "
        "WHERE tenant_id=$1 AND feature_key='field_service'",
        tenant.tenant_id,
    )
    assert (
        json.loads(await pg.fetchval("SELECT workflow_policy FROM service.cases WHERE id=$1", case))
        == POLICY
    )
    assert await pg.fetchval(
        "SELECT service.validate_workflow_policy($1::jsonb)", json.dumps(POLICY)
    )
    assert not await pg.fetchval(
        "SELECT service.validate_workflow_policy($1::jsonb)",
        json.dumps({**POLICY, "requiredIntakeFields": []}),
    )
    assert not await pg.fetchval(
        "SELECT service.validate_workflow_policy($1::jsonb)",
        json.dumps({**POLICY, "unexpected": True}),
    )
    assert not await pg.fetchval(
        "SELECT service.validate_workflow_policy($1::jsonb)",
        json.dumps({key: value for key, value in POLICY.items() if key != "version"}),
    )


@pytest.mark.parametrize("same_message", [False, True])
@pytest.mark.parametrize("correlation", ["event", "job"])
async def test_ticket_link_requires_exact_intake_evidence_not_conversation_recency(
    pg, same_message, correlation
):
    tenant = await _tenant(pg, "Ticket correlation fixture", enabled=True)
    channel = await pg.fetchval(
        "INSERT INTO messaging.channels(tenant_id,kind,provider,provider_account_id,status) "
        "VALUES($1,'whatsapp','simulator',$2,'active') RETURNING id",
        tenant.tenant_id,
        str(uuid4()),
    )
    conversation = await pg.fetchval(
        "INSERT INTO messaging.conversations(tenant_id,channel_id,contact_id) "
        "VALUES($1,$2,$3) RETURNING id",
        tenant.tenant_id,
        channel,
        tenant.contact_id,
    )
    message = await pg.fetchval(
        "INSERT INTO messaging.messages(tenant_id,conversation_id,direction,sender_type,"
        "content_type,content_text,provider,status) "
        "VALUES($1,$2,'inbound','contact','text','Current issue','simulator','received') "
        "RETURNING id",
        tenant.tenant_id,
        conversation,
    )
    draft = await pg.fetchval(
        "INSERT INTO service.intake_drafts(tenant_id,conversation_id,reporting_contact_id,"
        "correlation_key) VALUES($1,$2,$3,'correlation-fixture') RETURNING id",
        tenant.tenant_id,
        conversation,
        tenant.contact_id,
    )
    await pg.execute(
        "INSERT INTO service.intake_messages(tenant_id,intake_draft_id,message_id) "
        "VALUES($1,$2,$3)",
        tenant.tenant_id,
        draft,
        message,
    )
    previous = await pg.fetchval(
        "INSERT INTO support.tickets(tenant_id,reference,attachment_key,contact_id,subject,"
        "source_conversation_id) VALUES($1,'T-FIXTURE','fixture-ticket',$2,'Earlier request',$3) "
        "RETURNING id",
        tenant.tenant_id,
        tenant.contact_id,
        conversation,
    )
    if correlation == "job":
        job = await pg.fetchval(
            "INSERT INTO ops.jobs(tenant_id,queue,job_type,payload) "
            "VALUES($1,'messaging','whatsapp.ai.reply',$2::jsonb) RETURNING id",
            tenant.tenant_id,
            json.dumps({"triggerMessageId": str(message if same_message else uuid4())}),
        )
        await pg.execute(
            "UPDATE support.tickets SET attachment_key=$2 WHERE id=$1",
            previous,
            f"whatsapp-ai-issue:{job}",
        )
    await pg.execute(
        "INSERT INTO support.ticket_events(tenant_id,ticket_id,sequence,kind,actor_kind,"
        "visibility,summary_safe,evidence) VALUES($1,$2,1,'opened','system','internal',"
        "'Fixture receipt',$3::jsonb)",
        tenant.tenant_id,
        previous,
        json.dumps(
            {"messageId": str(message if same_message and correlation == "event" else uuid4())}
        ),
    )
    case = await pg.fetchval(
        "INSERT INTO service.cases(tenant_id,reference,customer_contact_id,title,"
        "fault_description,intake_draft_id,conversation_id) "
        "VALUES($1,'FS-CORRELATION',$2,'Current issue','Fault details',$3,$4) RETURNING id",
        tenant.tenant_id,
        tenant.contact_id,
        draft,
        conversation,
    )
    linked = await pg.fetchval("SELECT id FROM support.tickets WHERE service_case_id=$1", case)
    assert (linked == previous) is same_message
    assert await pg.fetchval(
        "SELECT count(*) FROM support.tickets WHERE tenant_id=$1", tenant.tenant_id
    ) == (1 if same_message else 2)
