"""Exercise executable voice intake against PostgreSQL using the real runtime role."""

import json
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from dispatcher_runtime.persistence import PostgresVoiceRuntime, _async_database_url
from oron_common import CallContext, Direction
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from db.tests.postgres.lead_capture_support import execute, seed_agent, seed_call

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


@pytest_asyncio.fixture
async def service_runtime(postgres_url, request):
    engine = create_async_engine(_async_database_url(postgres_url))
    async with engine.connect() as connection:
        transaction = await connection.begin()
        try:
            tenant, contact = uuid4(), uuid4()
            policy = {
                "version": 1,
                "requiredIntakeFields": [
                    "customerName",
                    "customerPhone",
                    "chainName",
                    "storeName",
                    "faultDescription",
                    "exactFailure",
                ],
                "photoPolicy": "requested",
                "selfAssignmentEnabled": True,
                "requiredReportFields": ["diagnosis", "workPerformed"],
            }
            await execute(
                connection,
                "INSERT INTO tenants(id,name,slug) VALUES(:tenant,:name,:slug)",
                tenant=tenant,
                name="Fictional service tenant",
                slug=f"voice-service-{tenant}",
            )
            await execute(
                connection,
                "SELECT set_config('app.current_tenant',:tenant,true)",
                tenant=str(tenant),
            )
            await execute(
                connection,
                "INSERT INTO platform.tenant_feature_entitlements"
                "(tenant_id,feature_key,available,enabled,configuration,granted_at) "
                "VALUES(:tenant,'field_service',true,true,CAST(:configuration AS jsonb),now())",
                tenant=tenant,
                configuration=json.dumps({"workflow": policy}),
            )
            await execute(
                connection,
                "INSERT INTO service.tenant_configuration(tenant_id,enabled) VALUES(:tenant,true)",
                tenant=tenant,
            )
            await execute(
                connection,
                "INSERT INTO crm.contacts(id,tenant_id,name) "
                "VALUES(:contact,:tenant,'Fixture caller')",
                contact=contact,
                tenant=tenant,
            )
            await execute(
                connection,
                "INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,"
                "normalized_value,validation_status,is_primary) "
                "VALUES(:tenant,:contact,'phone','+972502345678','valid',false),"
                "(:tenant,:contact,'phone','+972509876543','valid',true)",
                tenant=tenant,
                contact=contact,
            )
            agent = UUID(await seed_agent(connection, tenant, ["service.intake"]))
            session = await seed_call(connection, tenant, contact)
            runtime = object.__new__(PostgresVoiceRuntime)
            runtime._sessionmaker = async_sessionmaker(
                bind=connection,
                class_=AsyncSession,
                expire_on_commit=False,
                join_transaction_mode="create_savepoint",
            )
            context = CallContext(
                call_id="service-integration",
                tenant_id=tenant,
                session_id=session,
                flow_id=uuid4(),
                direction=Direction.INBOUND,
                contact_id=contact,
                from_number="+972502345678",
            )
            await connection.execute(text("SET LOCAL ROLE platform_voice"))
            await runtime.pin_voice_agent(context, agent)
            if getattr(request, "param", True):
                # Existing happy workflows now use an actual independent factor
                # proof; a correlated caller-ID is never substituted for it.
                await connection.execute(text("RESET ROLE"))
                channel = (
                    await execute(
                        connection,
                        "INSERT INTO messaging.channels(tenant_id,kind,provider,"
                        "provider_account_id,status) "
                        "VALUES(:tenant,'whatsapp','simulator',:account,'active') RETURNING id",
                        tenant=tenant,
                        account=f"verification-{session}",
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
                handoff = (
                    await execute(
                        connection,
                        "INSERT INTO automation.handoffs(tenant_id,contact_id,conversation_id,"
                        "source_channel,reason_safe,idempotency_key) VALUES(:tenant,:contact,"
                        ":conversation,'whatsapp','Fictional verification',:key) RETURNING id",
                        tenant=tenant,
                        contact=contact,
                        conversation=conversation,
                        key=f"verification-{session}",
                    )
                ).scalar_one()
                await execute(
                    connection,
                    "INSERT INTO crm.customer_profiles(tenant_id,contact_id,national_id_ciphertext,"
                    "national_id_blind_index,national_id_hint) VALUES(:tenant,:contact,"
                    "'v1:fictional','fictional-factor-index','0000')",
                    tenant=tenant,
                    contact=contact,
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                await execute(
                    connection,
                    "SELECT platform.initialize_voice_identity_verification(:session,:handoff)",
                    session=session,
                    handoff=handoff,
                )
                receipt = (
                    await execute(
                        connection,
                        "SELECT platform.verify_voice_caller_identity(:session,'fixturecaller',"
                        "'+972502345678','fictional-factor-index',NULL)",
                        session=session,
                    )
                ).scalar_one()
                assert receipt["verified"] is True

            yield runtime, context, connection, policy
        finally:
            await transaction.rollback()
    await engine.dispose()


async def test_voice_intake_recovers_draft_and_creates_one_linked_case_ticket(service_runtime):
    runtime, context, connection, _ = service_runtime
    initial = await runtime.get_service_intake_context(context)
    assert initial["knownFields"]["customerName"] == "Fixture caller"
    assert initial["knownFields"]["customerPhone"] == "+972502345678"
    assert initial["intakeId"] is None
    draft = await runtime.capture_service_intake(
        context,
        fields={
            "chainName": "Fictional retail",
            "storeName": "Branch one",
            "faultDescription": "Receipt printer stopped",
        },
        confirmed=True,
    )
    assert draft["status"] == "collecting"
    assert draft["missingFields"] == ["exactFailure"]
    assert draft["caseId"] is None and draft["ticketId"] is None
    assert (await runtime.get_service_intake_context(context))["intakeId"] == draft["intakeId"]
    complete = await runtime.capture_service_intake(
        context, fields={"exactFailure": "Paper feeds but print is blank"}, confirmed=True
    )
    assert complete["status"] == "confirmed"
    assert complete["caseId"] and complete["ticketId"] and complete["reference"]
    repeated = await runtime.capture_service_intake(context, fields={}, confirmed=True)
    assert repeated["caseId"] == complete["caseId"]
    assert repeated["ticketId"] == complete["ticketId"]
    await connection.execute(text("RESET ROLE"))
    counts = (
        (
            await execute(
                connection,
                "SELECT (SELECT count(*) FROM service.cases WHERE tenant_id=:tenant) AS cases,"
                "(SELECT count(*) FROM support.tickets WHERE tenant_id=:tenant) AS tickets,"
                "(SELECT count(*) FROM service.case_calls WHERE tenant_id=:tenant "
                "AND session_id=:session) AS call_links",
                tenant=context.tenant_id,
                session=context.session_id,
            )
        )
        .mappings()
        .one()
    )
    assert dict(counts) == {"cases": 1, "tickets": 1, "call_links": 1}


@pytest.mark.parametrize("governance", ["module_only", "reviewed", "legacy"])
async def test_voice_resolver_uses_reviewed_flow_and_denies_module_only_fallback(
    service_runtime, governance
):
    runtime, context, connection, _ = service_runtime
    await connection.execute(text("RESET ROLE"))
    agent = (
        await execute(
            connection,
            "SELECT (payload->>'agent_version_id')::uuid FROM session_events "
            "WHERE session_id=:session AND event_type='voice.agent.binding.v1'",
            session=context.session_id,
        )
    ).scalar_one()
    definition, approved_flow = uuid4(), uuid4()
    await execute(
        connection,
        "INSERT INTO automation.flow_definitions(id,tenant_id,name,channel_capabilities) "
        "VALUES(:id,:tenant,'Fictional governed flow',ARRAY['voice'])",
        id=definition,
        tenant=context.tenant_id,
    )
    for version, flow_id in ((1, approved_flow), (2, uuid4())):
        await execute(
            connection,
            "INSERT INTO automation.flow_versions(id,tenant_id,flow_definition_id,version,"
            "schema_version,definition,agent_profile_version_id,validation_status,published_at) "
            "VALUES(:id,:tenant,:definition,:version,'1.0',CAST(:nodes AS jsonb),:agent,"
            "'valid',CURRENT_TIMESTAMP+(:version-1)*INTERVAL '1 second')",
            id=flow_id,
            tenant=context.tenant_id,
            definition=definition,
            version=version,
            agent=agent,
            nodes=json.dumps(
                {
                    "nodes": [
                        {
                            "id": "voice",
                            "type": "voice.call",
                            "configuration": {
                                "flowId": str(context.flow_id),
                                "flowVersion": version,
                            },
                        }
                    ]
                }
            ),
        )
    if governance == "reviewed":
        await execute(
            connection,
            "INSERT INTO automation.tenant_processes(tenant_id,name,enabled,trigger_key,"
            "channel,agent_profile_version_id,flow_version_id) "
            "VALUES(:tenant,'Reviewed voice',true,'voice.inbound',NULL,:agent,:flow)",
            tenant=context.tenant_id,
            agent=agent,
            flow=approved_flow,
        )
    await execute(
        connection,
        "INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,"
        "configuration,approved_at) VALUES(:tenant,:version,'published','{}',CURRENT_TIMESTAMP)",
        tenant=context.tenant_id,
        version=1 if governance == "legacy" else 2,
    )
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    if governance != "module_only":
        resolved = await runtime.get_voice_configuration(
            context.flow_id, tenant_id=context.tenant_id
        )
        assert resolved["agentVersionId"] == str(agent)
        assert resolved["flowVersion"] == 1
    else:
        with pytest.raises(ValueError, match="published voice agent binding is unavailable"):
            await runtime.get_voice_configuration(context.flow_id, tenant_id=context.tenant_id)


async def test_running_voice_intake_keeps_published_requirements(service_runtime):
    runtime, context, connection, policy = service_runtime
    assert (await runtime.get_service_intake_context(context))["policy"] == policy
    await connection.execute(text("RESET ROLE"))
    successor = {
        **policy,
        "requiredIntakeFields": [*policy["requiredIntakeFields"], "serialNumber"],
    }
    await execute(
        connection,
        "UPDATE platform.tenant_feature_entitlements "
        "SET configuration=CAST(:configuration AS jsonb)"
        " WHERE tenant_id=:tenant AND feature_key='field_service'",
        tenant=context.tenant_id,
        configuration=json.dumps({"workflow": successor}),
    )
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    resumed = await runtime.capture_service_intake(
        context, fields={"faultDescription": "Fault"}, confirmed=False
    )
    assert resumed["policy"] == policy
    assert "serialNumber" not in resumed["missingFields"]


async def test_outbound_intake_uses_called_number_not_contact_primary_or_business_number(
    service_runtime,
):
    runtime, context, connection, _ = service_runtime
    await connection.execute(text("RESET ROLE"))
    agent = UUID(
        (
            await execute(
                connection,
                "SELECT payload->>'agent_version_id' FROM public.session_events "
                "WHERE tenant_id=:tenant AND session_id=:session "
                "AND event_type='voice.agent.binding.v1'",
                tenant=context.tenant_id,
                session=context.session_id,
            )
        ).scalar_one()
    )
    session = await seed_call(connection, context.tenant_id, context.contact_id)
    outbound = context.model_copy(
        update={
            "session_id": session,
            "direction": Direction.OUTBOUND,
            "from_number": "+972509876543",
            "to_number": "+972502345678",
        }
    )
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    await runtime.pin_voice_agent(outbound, agent)
    result = await runtime.get_service_intake_context(outbound)
    # Correlation on a new call never inherits the first session's factor proof.
    assert result["knownFields"] == {} and result["storeOptions"] == []
    await connection.execute(text("RESET ROLE"))
    identity = (
        await execute(
            connection,
            "SELECT identity.normalized_value FROM public.session_events event "
            "JOIN crm.contact_channel_identities identity ON identity.tenant_id=event.tenant_id "
            "AND identity.id=(event.payload->>'caller_identity_id')::uuid "
            "WHERE event.tenant_id=:tenant AND event.session_id=:session "
            "AND event.event_type='voice.agent.binding.v1'",
            tenant=context.tenant_id,
            session=session,
        )
    ).scalar_one()
    assert identity == "+972502345678"


async def test_voice_service_rejects_cross_tenant_and_model_phone_substitution(service_runtime):
    runtime, context, _, _ = service_runtime
    with pytest.raises(DBAPIError):
        await runtime.capture_service_intake(
            context, fields={"customerPhone": "+972500000000"}, confirmed=False
        )
    other_tenant = context.model_copy(update={"tenant_id": uuid4()})
    with pytest.raises(DBAPIError):
        await runtime.get_service_intake_context(other_tenant)
    initial = await runtime.get_service_intake_context(context)
    assert initial["knownFields"]["customerPhone"] == "+972502345678"
    assert initial["intakeId"] is None


async def test_paused_or_ended_voice_session_cannot_continue_automatic_intake(service_runtime):
    runtime, context, connection, _ = service_runtime
    assert (await runtime.read_voice_control(context))["active"] is True
    await connection.execute(text("RESET ROLE"))
    await execute(
        connection,
        "UPDATE public.voice_session_controls SET desired_mode='paused' "
        "WHERE tenant_id=:tenant AND session_id=:session",
        tenant=context.tenant_id,
        session=context.session_id,
    )
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    with pytest.raises(DBAPIError):
        await runtime.capture_service_intake(
            context, fields={"faultDescription": "Fault"}, confirmed=False
        )
    await connection.execute(text("RESET ROLE"))
    await execute(
        connection,
        "UPDATE public.voice_session_controls SET desired_mode='ai' "
        "WHERE tenant_id=:tenant AND session_id=:session",
        tenant=context.tenant_id,
        session=context.session_id,
    )
    await execute(
        connection,
        "UPDATE public.sessions SET status='ended',ended_at=CURRENT_TIMESTAMP "
        "WHERE tenant_id=:tenant AND session_id=:session",
        tenant=context.tenant_id,
        session=context.session_id,
    )
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    with pytest.raises(DBAPIError):
        await runtime.capture_service_intake(
            context, fields={"faultDescription": "Fault"}, confirmed=False
        )


async def test_photo_request_without_an_eligible_whatsapp_conversation_is_refused(service_runtime):
    runtime, context, connection, _ = service_runtime
    await runtime.capture_service_intake(
        context, fields={"faultDescription": "Blank output"}, confirmed=False
    )
    result = await runtime.request_service_photos(context, message="Please send a photo.")
    assert result["status"] == "unavailable"
    await connection.execute(text("RESET ROLE"))
    assert (
        await execute(
            connection,
            "SELECT count(*) FROM ops.jobs WHERE tenant_id=:tenant",
            tenant=context.tenant_id,
        )
    ).scalar_one() == 0


async def test_voice_photos_join_the_same_case_before_and_after_confirmation(service_runtime):
    runtime, context, connection, _ = service_runtime
    await connection.execute(text("RESET ROLE"))
    channel, conversation, actor = uuid4(), uuid4(), uuid4()
    whatsapp_agent = UUID(await seed_agent(connection, context.tenant_id, ["service.intake"]))
    await execute(
        connection,
        "INSERT INTO users(id,email,status) VALUES(:actor,:email,'active')",
        actor=actor,
        email=f"{actor}@example.test",
    )
    await execute(
        connection,
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES(:tenant,:actor,'owner')",
        tenant=context.tenant_id,
        actor=actor,
    )
    await execute(
        connection,
        "UPDATE crm.contacts SET whatsapp_consent='granted' "
        "WHERE tenant_id=:tenant AND id=:contact",
        tenant=context.tenant_id,
        contact=context.contact_id,
    )
    await execute(
        connection,
        "INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,status) "
        "VALUES(:channel,:tenant,'whatsapp','meta',:account,'active')",
        channel=channel,
        tenant=context.tenant_id,
        account=f"fictional-{channel}",
    )
    await execute(
        connection,
        "INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,"
        "customer_service_window_expires_at,ownership_mode,ai_agent_profile_version_id,"
        "ai_enabled_by_user_id,ai_enabled_at) VALUES(:conversation,:tenant,:channel,:contact,"
        "CURRENT_TIMESTAMP+INTERVAL '1 hour','ai',:agent,:actor,CURRENT_TIMESTAMP)",
        conversation=conversation,
        tenant=context.tenant_id,
        channel=channel,
        contact=context.contact_id,
        agent=whatsapp_agent,
        actor=actor,
    )
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    draft = await runtime.capture_service_intake(
        context,
        fields={
            "chainName": "Fictional chain",
            "storeName": "Fictional branch",
            "faultDescription": "Printer output is blank",
            "exactFailure": "No ink",
        },
        confirmed=False,
    )
    queued = await runtime.request_service_photos(context, message="Please reply with a photo.")
    assert queued["status"] == "queued", queued
    assert queued["intakeId"] == draft["intakeId"]
    retry = await runtime.request_service_photos(context, message="Please reply with a photo.")
    assert retry["jobId"] == queued["jobId"]

    async def receive_photo():
        await connection.execute(text("RESET ROLE"))
        message, object_id = uuid4(), uuid4()
        await execute(
            connection,
            "INSERT INTO objects.object_metadata(id,tenant_id,owner_type,owner_id,category,"
            "content_type,byte_size,checksum,storage_backend,storage_key,status) "
            "VALUES(:object,:tenant,'message',:message,'customer_photo','image/png',9,"
            ":checksum,'local',:key,'available')",
            object=object_id,
            tenant=context.tenant_id,
            message=message,
            checksum=uuid4().hex + uuid4().hex,
            key=f"fictional/{context.tenant_id}/{object_id}.png",
        )
        await execute(
            connection,
            "INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,"
            "content_type,provider,status,object_id) "
            "VALUES(:message,:tenant,:conversation,'inbound','contact','image','meta','received',"
            ":object)",
            message=message,
            tenant=context.tenant_id,
            conversation=conversation,
            object=object_id,
        )
        await connection.execute(text("SET LOCAL ROLE platform_voice"))
        return message

    first_message = await receive_photo()
    completed = await runtime.capture_service_intake(context, fields={}, confirmed=True)
    assert completed["caseId"] and completed["ticketId"]
    second_message = await receive_photo()
    await connection.execute(text("RESET ROLE"))
    attachments = (
        (
            await execute(
                connection,
                "SELECT message_id FROM service.report_attachments "
                "WHERE tenant_id=:tenant AND case_id=:case ORDER BY message_id",
                tenant=context.tenant_id,
                case=UUID(completed["caseId"]),
            )
        )
        .scalars()
        .all()
    )
    assert set(attachments) == {first_message, second_message}
    assert (
        await execute(
            connection,
            "SELECT count(*) FROM service.case_conversations "
            "WHERE tenant_id=:tenant AND case_id=:case AND conversation_id=:conversation",
            tenant=context.tenant_id,
            case=UUID(completed["caseId"]),
            conversation=conversation,
        )
    ).scalar_one() == 1


@pytest.mark.parametrize("service_runtime", [False], indirect=True)
async def test_unverified_transport_identity_does_not_unlock_private_crm_prefill(service_runtime):
    runtime, context, _connection, _policy = service_runtime
    initial = await runtime.get_service_intake_context(context)
    # Even a globally valid contact phone is only correlation; this call supplied
    # no independent factors and has no session-bound verification receipt.
    assert "customerName" not in initial["knownFields"]
    assert initial["storeOptions"] == []


@pytest.mark.parametrize("service_runtime", [False], indirect=True)
async def test_unverified_caller_intake_keeps_only_same_call_claims(service_runtime):
    runtime, context, connection, _policy = service_runtime
    result = await runtime.capture_service_intake(
        context,
        fields={
            "customerName": "Caller stated name",
            "chainName": "Caller stated chain",
            "storeName": "Caller stated branch",
            "faultDescription": "Caller stated fault",
            "exactFailure": "Caller stated symptom",
        },
        confirmed=True,
    )
    assert result["knownFields"]["customerName"] == "Caller stated name"
    assert result["storeOptions"] == []
    assert "Fixture caller" not in str(result)

    assert result["status"] == "confirmed" and result["caseId"] and result["ticketId"]
    await connection.execute(text("RESET ROLE"))
    provenance = (
        await execute(
            connection,
            "SELECT payload FROM public.session_events WHERE tenant_id=:tenant "
            "AND session_id=:session AND event_type='voice.caller.correlation.v1'",
            tenant=context.tenant_id,
            session=context.session_id,
        )
    ).scalar_one()
    assert provenance == {
        "source": "provider_transport",
        "identity_verified": False,
        "purpose": "callback_routing",
    }
    assert (
        await execute(
            connection,
            "SELECT count(*) FROM automation.voice_identity_verifications "
            "WHERE tenant_id=:tenant AND session_id=:session",
            tenant=context.tenant_id,
            session=context.session_id,
        )
    ).scalar_one() == 0


async def test_verified_prefill_rechecks_revoked_pinned_identity(service_runtime):
    runtime, context, connection, _policy = service_runtime
    assert (await runtime.get_service_intake_context(context))["knownFields"][
        "customerName"
    ] == "Fixture caller"
    await connection.execute(text("RESET ROLE"))
    await execute(
        connection,
        "UPDATE crm.contact_channel_identities SET validation_status='revoked' "
        "WHERE tenant_id=:tenant AND contact_id=:contact",
        tenant=context.tenant_id,
        contact=context.contact_id,
    )
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    result = await runtime.get_service_intake_context(context)
    assert result["knownFields"] == {} and result["storeOptions"] == []


async def test_pending_verification_keeps_private_context_locked(service_runtime):
    runtime, context, connection, _policy = service_runtime
    await connection.execute(text("RESET ROLE"))
    await execute(
        connection,
        "UPDATE automation.voice_identity_verifications SET state='collecting_identity',"
        "verified_at=NULL,context_unlocked_at=NULL WHERE tenant_id=:tenant AND session_id=:session",
        tenant=context.tenant_id,
        session=context.session_id,
    )
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    result = await runtime.get_service_intake_context(context)
    assert result["status"] == "identity_required" and result["knownFields"] == {}


async def test_archived_bound_agent_cannot_read_verified_private_prefill(service_runtime):
    runtime, context, connection, _policy = service_runtime
    await connection.execute(text("RESET ROLE"))
    await execute(
        connection,
        "UPDATE agents.agent_profiles SET archived_at=clock_timestamp() WHERE tenant_id=:tenant",
        tenant=context.tenant_id,
    )
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    with pytest.raises(DBAPIError):
        await runtime.get_service_intake_context(context)


@pytest.mark.parametrize("service_runtime", [False], indirect=True)
async def test_unverified_legacy_draft_keeps_private_history_without_disclosure(service_runtime):
    runtime, context, connection, policy = service_runtime
    await connection.execute(text("RESET ROLE"))
    private = {
        "customerName": "Legacy private customer",
        "storeName": "Legacy private branch",
        "serviceAddress": "Legacy private address",
    }
    draft = (
        await execute(
            connection,
            "INSERT INTO service.intake_drafts(tenant_id,source_session_id,reporting_contact_id,"
            "customer_contact_id,customer_resolution_status,correlation_key,collected_fields,"
            "workflow_policy,status) VALUES(:tenant,:session,:contact,:contact,'reporting_contact',"
            ":key,CAST(:fields AS jsonb),CAST(:policy AS jsonb),'collecting') RETURNING id",
            tenant=context.tenant_id,
            session=context.session_id,
            contact=context.contact_id,
            key=f"legacy-{context.session_id}",
            fields=json.dumps(private),
            policy=json.dumps(policy),
        )
    ).scalar_one()
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    result = await runtime.get_service_intake_context(context)
    assert result["status"] == "identity_required" and result["knownFields"] == {}
    assert result["storeOptions"] == [] and result["intakeId"] is None
    assert result["caseId"] is None and result["ticketId"] is None
    assert "Legacy private" not in str(result)
    with pytest.raises(DBAPIError):
        await runtime.capture_service_intake(
            context, fields={"customerName": "New caller"}, confirmed=False
        )
    await connection.execute(text("RESET ROLE"))
    retained = (
        await execute(
            connection,
            "SELECT collected_fields FROM service.intake_drafts "
            "WHERE tenant_id=:tenant AND id=:draft",
            tenant=context.tenant_id,
            draft=draft,
        )
    ).scalar_one()
    assert retained == private


async def test_runtime_retains_exact_compiled_voice_flow_and_rejects_retry_drift(service_runtime):
    runtime, context, connection, _ = service_runtime
    await connection.execute(text("RESET ROLE"))
    agent = (
        await execute(
            connection,
            "SELECT (payload->>'agent_version_id')::uuid FROM session_events "
            "WHERE session_id=:session AND event_type='voice.agent.binding.v1'",
            session=context.session_id,
        )
    ).scalar_one()
    fresh_session = await seed_call(connection, context.tenant_id, context.contact_id)
    fresh = context.model_copy(update={"session_id": fresh_session})
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    await runtime.pin_voice_agent(fresh, agent, compiled_flow_version=3)
    await runtime.pin_voice_agent(fresh, agent, compiled_flow_version=3)
    retained = (
        (
            await execute(
                connection,
                "SELECT sequence,payload FROM session_events WHERE session_id=:session "
                "AND event_type='voice.flow.binding.v1'",
                session=fresh_session,
            )
        )
        .mappings()
        .all()
    )
    assert len(retained) == 1
    assert retained[0]["payload"] == {
        "compiled_flow_id": str(context.flow_id),
        "compiled_flow_version": 3,
        "agent_version_id": str(agent),
    }
    with pytest.raises(ValueError, match="flow binding cannot change"):
        await runtime.pin_voice_agent(fresh, agent, compiled_flow_version=4)
    assert (
        await execute(
            connection,
            "SELECT count(*) FROM session_events WHERE session_id=:session "
            "AND event_type='voice.flow.binding.v1'",
            session=fresh_session,
        )
    ).scalar_one() == 1
