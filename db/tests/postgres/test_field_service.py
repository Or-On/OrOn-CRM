from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import asyncpg
import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


@dataclass(frozen=True)
class TenantFixture:
    tenant_id: UUID
    user_id: UUID
    contact_id: UUID


async def _tenant(pg: asyncpg.Connection, name: str, *, enabled: bool = False) -> TenantFixture:
    tenant_id = uuid4()
    user_id = uuid4()
    contact_id = uuid4()
    await pg.execute(
        "INSERT INTO tenants(id,name,slug) VALUES ($1,$2,$3)",
        tenant_id,
        name,
        f"field-service-{tenant_id}",
    )
    await pg.execute(
        "INSERT INTO users(id,email,status) VALUES ($1,$2,'active')",
        user_id,
        f"{user_id}@example.test",
    )
    await pg.execute(
        "INSERT INTO memberships(user_id,tenant_id,role) VALUES ($1,$2,'owner')",
        user_id,
        tenant_id,
    )
    await pg.execute(
        "INSERT INTO crm.contacts(id,tenant_id,name) VALUES ($1,$2,$3)",
        contact_id,
        tenant_id,
        f"{name} customer",
    )
    if enabled:
        await pg.execute(
            "INSERT INTO platform.tenant_feature_entitlements"
            "(tenant_id,feature_key,available,granted_by_user_id,granted_at) "
            "VALUES ($1,'field_service',true,$2,CURRENT_TIMESTAMP)",
            tenant_id,
            user_id,
        )
        await pg.execute(
            "INSERT INTO service.tenant_configuration(tenant_id,enabled) VALUES ($1,true)",
            tenant_id,
        )
    return TenantFixture(tenant_id, user_id, contact_id)


async def _as_web(pg: asyncpg.Connection, fixture: TenantFixture) -> None:
    await pg.execute("SET LOCAL ROLE platform_web")
    await pg.execute(
        "SELECT set_config('app.current_tenant',$1,true),"
        "set_config('app.current_user',$2,true),"
        "set_config('app.current_role','owner',true)",
        str(fixture.tenant_id),
        str(fixture.user_id),
    )


async def _auth_session(pg: asyncpg.Connection, user_id: UUID, tenant_id: UUID, label: str) -> UUID:
    now = datetime.now(UTC)
    return await pg.fetchval(
        "SELECT platform.auth_create_session($1,$2,$3,$4,43200,$5,$6,NULL,NULL,$7)",
        user_id,
        tenant_id,
        uuid4().bytes + uuid4().bytes,
        uuid4().bytes + uuid4().bytes,
        now + timedelta(hours=12),
        now + timedelta(days=7),
        label,
    )


async def test_authenticated_session_context_is_narrow_and_cannot_be_spoofed(
    pg: asyncpg.Connection,
) -> None:
    first = await _tenant(pg, "Session context first", enabled=True)
    second = await _tenant(pg, "Session context second", enabled=True)
    first_session = await _auth_session(pg, first.user_id, first.tenant_id, "field-session-first")
    second_session = await _auth_session(
        pg, second.user_id, second.tenant_id, "field-session-second"
    )

    await _as_web(pg, first)
    await pg.execute("SELECT set_config('app.current_session',$1,true)", str(first_session))
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval(
                "SELECT absolute_expires_at FROM platform.auth_sessions WHERE id=$1",
                first_session,
            )

    context = await pg.fetchrow(
        "SELECT session_id,absolute_expires_at "
        "FROM service.lock_current_technician_session_context()"
    )
    assert context is not None
    assert context["session_id"] == first_session
    assert context["absolute_expires_at"] > datetime.now(UTC)

    await pg.execute("SELECT set_config('app.current_session',$1,true)", str(second_session))
    assert (
        await pg.fetchrow("SELECT * FROM service.lock_current_technician_session_context()") is None
    )
    await pg.execute("SELECT set_config('app.current_session','not-a-session',true)")
    assert (
        await pg.fetchrow("SELECT * FROM service.lock_current_technician_session_context()") is None
    )

    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE platform.auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1",
        first_session,
    )
    await _as_web(pg, first)
    await pg.execute("SELECT set_config('app.current_session',$1,true)", str(first_session))
    assert (
        await pg.fetchrow("SELECT * FROM service.lock_current_technician_session_context()") is None
    )


async def test_report_branding_reads_only_the_authorized_current_tenant_name(
    pg: asyncpg.Connection,
) -> None:
    first = await _tenant(pg, "Report branding first", enabled=True)
    second = await _tenant(pg, "Report branding second", enabled=True)
    await pg.execute(
        "INSERT INTO crm.tenant_settings"
        "(tenant_id,display_name,default_currency,locale,timezone) "
        "VALUES ($1,NULL,'USD','en','UTC'),($2,NULL,'USD','en','UTC')",
        first.tenant_id,
        second.tenant_id,
    )

    await _as_web(pg, first)
    assert await pg.fetchval("SELECT platform.current_tenant_name()") == "Report branding first"
    assert (
        await pg.fetchval(
            "SELECT coalesce(settings.business_name,settings.display_name,"
            "platform.current_tenant_name()) "
            "FROM crm.tenant_settings settings "
            "WHERE settings.tenant_id=platform.current_tenant_id()"
        )
        == "Report branding first"
    )
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval("SELECT name FROM public.tenants WHERE id=$1", first.tenant_id)

    # Changing only the tenant GUC cannot reveal another tenant's name because
    # the actor must be an active member of the selected tenant.
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(second.tenant_id))
    assert await pg.fetchval("SELECT platform.current_tenant_name()") is None


async def test_technician_identity_requires_a_valid_scoped_session(
    pg: asyncpg.Connection,
) -> None:
    fixture = await _tenant(pg, "Technician identity", enabled=True)
    foreign = await _tenant(pg, "Foreign technician identity", enabled=True)
    technician_user = uuid4()
    viewer_user = uuid4()
    await pg.execute(
        "INSERT INTO users(id,email,status) VALUES ($1,$2,'active'),($3,$4,'active')",
        technician_user,
        f"{technician_user}@example.test",
        viewer_user,
        f"{viewer_user}@example.test",
    )
    await pg.execute(
        "INSERT INTO memberships(user_id,tenant_id,role) VALUES "
        "($1,$2,'technician'),($3,$2,'viewer')",
        technician_user,
        fixture.tenant_id,
        viewer_user,
    )
    technician_id = await pg.fetchval(
        "INSERT INTO service.technicians"
        "(tenant_id,linked_user_id,full_name,employee_identifier,created_by_user_id) "
        "VALUES ($1,$2,'Fictional Technician','TECH-BOUNDARY',$3) RETURNING id",
        fixture.tenant_id,
        technician_user,
        fixture.user_id,
    )
    case_id = await pg.fetchval(
        "INSERT INTO service.cases"
        "(tenant_id,reference,customer_contact_id,title,fault_description,created_by_user_id) "
        "VALUES ($1,$2,$3,'Identity boundary case','Synthetic fault',$4) RETURNING id",
        fixture.tenant_id,
        f"FS-IDENTITY-{uuid4().hex[:8]}",
        fixture.contact_id,
        fixture.user_id,
    )
    visit_id = await pg.fetchval(
        "INSERT INTO service.visits(tenant_id,case_id,technician_id,visit_number) "
        "VALUES ($1,$2,$3,1) RETURNING id",
        fixture.tenant_id,
        case_id,
        technician_id,
    )
    valid_session = await _auth_session(
        pg, technician_user, fixture.tenant_id, "field-technician-valid"
    )
    revoked_session = await _auth_session(
        pg, technician_user, fixture.tenant_id, "field-technician-revoked"
    )
    expired_session = await _auth_session(
        pg, technician_user, fixture.tenant_id, "field-technician-expired"
    )
    viewer_session = await _auth_session(pg, viewer_user, fixture.tenant_id, "field-viewer-session")
    foreign_session = await _auth_session(
        pg, foreign.user_id, foreign.tenant_id, "field-foreign-session"
    )
    await pg.execute(
        "UPDATE platform.auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1",
        revoked_session,
    )
    await pg.execute(
        "UPDATE platform.auth_sessions "
        "SET idle_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        expired_session,
    )

    await pg.execute("SET LOCAL ROLE platform_web")

    async def context(user_id: UUID, role: str, session_id: UUID) -> asyncpg.Record | None:
        await pg.execute(
            "SELECT set_config('app.current_tenant',$1,true),"
            "set_config('app.current_user',$2,true),"
            "set_config('app.current_role',$3,true),"
            "set_config('app.current_session',$4,true)",
            str(fixture.tenant_id),
            str(user_id),
            role,
            str(session_id),
        )
        return await pg.fetchrow("SELECT * FROM service.lock_current_technician_session_context()")

    resolved = await context(technician_user, "technician", valid_session)
    assert resolved is not None
    assert resolved["session_id"] == valid_session
    identity_id = await pg.fetchval(
        "INSERT INTO service.technician_session_identities"
        "(tenant_id,auth_session_id,visit_id,technician_id,full_name,"
        "employee_identifier,verification_state,server_nonce,expires_at) "
        "SELECT platform.current_tenant_id(),session.session_id,$1,$2,"
        "'Fictional Technician','TECH-BOUNDARY','self_declared',$3,"
        "LEAST(session.absolute_expires_at,clock_timestamp()+interval '12 hours') "
        "FROM service.lock_current_technician_session_context() session RETURNING id",
        visit_id,
        technician_id,
        uuid4().hex,
    )
    assert identity_id is not None

    assert await context(viewer_user, "viewer", viewer_session) is None
    assert await context(technician_user, "technician", foreign_session) is None
    assert await context(technician_user, "technician", revoked_session) is None
    assert await context(technician_user, "technician", expired_session) is None


async def test_feature_defaults_off_but_customer_files_remain_available(
    pg: asyncpg.Connection,
) -> None:
    first = await _tenant(pg, "Disabled first")
    second = await _tenant(pg, "Disabled second")
    await _as_web(pg, first)

    assert not await pg.fetchval("SELECT service.field_service_enabled()")
    classification_id = await pg.fetchval(
        "INSERT INTO crm.customer_classifications"
        "(tenant_id,name,created_by_user_id) VALUES ($1,'Priority',$2) RETURNING id",
        first.tenant_id,
        first.user_id,
    )
    await pg.execute(
        "INSERT INTO crm.contact_classifications"
        "(tenant_id,contact_id,classification_id,assigned_by_user_id) "
        "VALUES ($1,$2,$3,$4)",
        first.tenant_id,
        first.contact_id,
        classification_id,
        first.user_id,
    )
    await pg.execute(
        "INSERT INTO crm.customer_profiles(tenant_id,contact_id,address) "
        "VALUES ($1,$2,'Synthetic address')",
        first.tenant_id,
        first.contact_id,
    )
    assert await pg.fetchval("SELECT count(*) FROM crm.customer_profiles") == 1
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO service.technicians(tenant_id,full_name) "
                "VALUES ($1,'Blocked technician')",
                first.tenant_id,
            )

    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(second.tenant_id))
    assert await pg.fetchval("SELECT count(*) FROM crm.customer_profiles") == 0
    assert await pg.fetchval("SELECT count(*) FROM crm.customer_classifications") == 0


async def test_feature_change_actor_uses_tenant_safe_identity_lookup(
    pg: asyncpg.Connection,
) -> None:
    fixture = await _tenant(pg, "Feature change actor", enabled=True)
    other = await _tenant(pg, "Other feature actor", enabled=True)
    expected_name = "Synthetic Feature Administrator"
    await pg.execute(
        "UPDATE users SET display_name=$1 WHERE id=$2",
        expected_name,
        fixture.user_id,
    )
    await pg.execute(
        "UPDATE service.tenant_configuration "
        "SET changed_by_user_id=$1, changed_at=CURRENT_TIMESTAMP "
        "WHERE tenant_id=$2",
        fixture.user_id,
        fixture.tenant_id,
    )

    await _as_web(pg, fixture)
    assert (
        await pg.fetchval(
            "SELECT platform.current_tenant_member_display_name($1)",
            fixture.user_id,
        )
        == expected_name
    )
    assert (
        await pg.fetchval(
            "SELECT platform.current_tenant_member_display_name($1)",
            other.user_id,
        )
        is None
    )
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval(
                "SELECT display_name FROM public.users WHERE id=$1",
                fixture.user_id,
            )

    await pg.execute("RESET ROLE")
    await pg.execute("SET LOCAL ROLE platform_worker")
    await pg.execute(
        "SELECT set_config('app.current_tenant',$1,true),"
        "set_config('app.current_user','',true),"
        "set_config('app.current_role','service',true)",
        str(fixture.tenant_id),
    )
    assert (
        await pg.fetchval(
            "SELECT platform.current_tenant_member_display_name($1)",
            fixture.user_id,
        )
        == expected_name
    )
    assert (
        await pg.fetchval(
            "SELECT platform.current_tenant_member_display_name($1)",
            other.user_id,
        )
        is None
    )


async def test_web_case_dossiers_can_read_only_required_call_evidence(
    pg: asyncpg.Connection,
) -> None:
    tenant_a = await _tenant(pg, "Voice projection tenant A")
    tenant_b = await _tenant(pg, "Voice projection tenant B")
    session_a = uuid4()
    session_b = uuid4()
    conversation_a = uuid4()
    conversation_b = uuid4()
    await pg.execute(
        """
        INSERT INTO public.sessions(
          session_id, tenant_id, contact_id, provider, direction, room,
          status, outcome, flow_id
        ) VALUES
          ($1, $2, $3, 'simulator', 'outbound', $4, 'ended', 'completed', $5),
          ($6, $7, $8, 'simulator', 'outbound', $9, 'ended', 'completed', $10)
        """,
        session_a,
        tenant_a.tenant_id,
        tenant_a.contact_id,
        f"voice-projection-{session_a}",
        uuid4(),
        session_b,
        tenant_b.tenant_id,
        tenant_b.contact_id,
        f"voice-projection-{session_b}",
        uuid4(),
    )
    await pg.execute(
        """
        INSERT INTO public.session_events(
          tenant_id, session_id, sequence, event_type, payload
        ) VALUES
          ($1, $2, 0, 'voice.call.admission.v1',
           jsonb_build_object('source_conversation_id', $3::uuid::text)),
          ($4, $5, 0, 'voice.call.admission.v1',
           jsonb_build_object('source_conversation_id', $6::uuid::text))
        """,
        tenant_a.tenant_id,
        session_a,
        conversation_a,
        tenant_b.tenant_id,
        session_b,
        conversation_b,
    )

    privileges = await pg.fetchrow(
        """
        SELECT
          has_column_privilege(
            'platform_web', 'public.sessions', 'direction', 'SELECT'
          ) AS can_read_direction,
          has_column_privilege(
            'platform_web', 'public.sessions', 'ended_at', 'SELECT'
          ) AS can_read_ended_at,
          has_column_privilege(
            'platform_web', 'public.sessions', 'recording_object_id', 'SELECT'
          ) AS can_read_recording_object,
          has_column_privilege(
            'platform_web', 'public.sessions', 'transcript_object_id', 'SELECT'
          ) AS can_read_transcript_object,
          has_column_privilege(
            'platform_web', 'public.session_events', 'event_type', 'SELECT'
          ) AS can_read_event_type,
          has_column_privilege(
            'platform_web', 'public.session_events', 'payload', 'SELECT'
          ) AS can_read_event_payload,
          has_function_privilege(
            'platform_web',
            'service.current_tenant_voice_admission_conversations(uuid)',
            'EXECUTE'
          ) AS can_read_admission_projection,
          has_column_privilege(
            'platform_web', 'public.sessions', 'from_number', 'SELECT'
          ) AS can_read_from_number,
          has_column_privilege(
            'platform_web', 'public.sessions', 'provider_call_id', 'SELECT'
          ) AS can_read_provider_call_id
        """
    )
    assert privileges is not None
    assert privileges["can_read_direction"]
    assert privileges["can_read_ended_at"]
    assert privileges["can_read_recording_object"]
    assert privileges["can_read_transcript_object"]
    assert not privileges["can_read_event_type"]
    assert not privileges["can_read_event_payload"]
    assert privileges["can_read_admission_projection"]
    assert not privileges["can_read_from_number"]
    assert not privileges["can_read_provider_call_id"]
    await _as_web(pg, tenant_a)
    projection = await pg.fetch(
        "SELECT voice_session_id, source_conversation_id "
        "FROM service.current_tenant_voice_admission_conversations($1)",
        session_a,
    )
    assert [(row["voice_session_id"], row["source_conversation_id"]) for row in projection] == [
        (session_a, conversation_a)
    ]
    assert all(row["voice_session_id"] != session_b for row in projection)
    assert all(row["source_conversation_id"] != conversation_b for row in projection)
    assert (
        await pg.fetch(
            "SELECT voice_session_id, source_conversation_id "
            "FROM service.current_tenant_voice_admission_conversations($1)",
            session_b,
        )
        == []
    )
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetch("SELECT payload FROM public.session_events")


async def test_platform_admin_can_manage_existing_tenant_entitlement(
    pg: asyncpg.Connection,
) -> None:
    administrator_tenant = await _tenant(pg, "Entitlement administrator")
    target = await _tenant(pg, "Entitlement target")
    await _as_web(pg, administrator_tenant)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute(
                "SELECT platform.set_tenant_feature_entitlement($1,true,$2)",
                target.tenant_id,
                "unauthorized-entitlement-test",
            )
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE users SET is_superuser=true WHERE id=$1",
        administrator_tenant.user_id,
    )
    await _as_web(pg, administrator_tenant)

    initial = {
        row["tenant_id"]: (row["available"], row["enabled"])
        for row in await pg.fetch(
            "SELECT * FROM platform.list_tenant_field_service_entitlements_for_administrator()"
        )
    }
    assert initial[administrator_tenant.tenant_id] == (False, False)
    assert initial[target.tenant_id] == (False, False)

    await pg.execute(
        "SELECT platform.set_tenant_feature_entitlement($1,true,$2)",
        target.tenant_id,
        "grant-field-service-test",
    )
    granted = await pg.fetchrow(
        "SELECT * FROM "
        "platform.list_tenant_field_service_entitlements_for_administrator() "
        "WHERE tenant_id=$1",
        target.tenant_id,
    )
    assert granted is not None
    assert granted["available"] is True
    assert granted["enabled"] is False

    await pg.execute(
        "SELECT platform.set_tenant_feature_entitlement($1,false,$2)",
        target.tenant_id,
        "revoke-field-service-test",
    )
    assert not await pg.fetchval(
        "SELECT available FROM "
        "platform.list_tenant_field_service_entitlements_for_administrator() "
        "WHERE tenant_id=$1",
        target.tenant_id,
    )
    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM audit.records "
            "WHERE tenant_id=$1 AND action='tenant.feature.entitlement.updated'",
            target.tenant_id,
        )
        == 2
    )


async def test_scheduling_is_tenant_scoped_and_prevents_conflicts(
    pg: asyncpg.Connection,
) -> None:
    fixture = await _tenant(pg, "Scheduling", enabled=True)
    other = await _tenant(pg, "Scheduling other", enabled=True)
    await _as_web(pg, fixture)
    technician_id = await pg.fetchval(
        "INSERT INTO service.technicians"
        "(tenant_id,full_name,employee_identifier,created_by_user_id) "
        "VALUES ($1,'Synthetic Technician','TECH-01',$2) RETURNING id",
        fixture.tenant_id,
        fixture.user_id,
    )
    case_id = await pg.fetchval(
        "INSERT INTO service.cases"
        "(tenant_id,reference,customer_contact_id,title,fault_description,created_by_user_id) "
        "VALUES ($1,'FS-TEST-1',$2,'No power','Unit does not start',$3) RETURNING id",
        fixture.tenant_id,
        fixture.contact_id,
        fixture.user_id,
    )
    await pg.execute(
        "INSERT INTO service.appointments"
        "(tenant_id,case_id,technician_id,starts_at,ends_at,timezone,idempotency_key,"
        "created_by_user_id) VALUES ($1,$2,$3,'2026-10-01T08:00:00Z',"
        "'2026-10-01T09:00:00Z','Asia/Jerusalem','first',$4)",
        fixture.tenant_id,
        case_id,
        technician_id,
        fixture.user_id,
    )
    with pytest.raises(asyncpg.ExclusionViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO service.appointments"
                "(tenant_id,case_id,technician_id,starts_at,ends_at,timezone,"
                "idempotency_key,created_by_user_id) VALUES "
                "($1,$2,$3,'2026-10-01T08:30:00Z','2026-10-01T09:30:00Z',"
                "'Asia/Jerusalem','overlap',$4)",
                fixture.tenant_id,
                case_id,
                technician_id,
                fixture.user_id,
            )
    assert await pg.fetchval("SELECT count(*) FROM service.appointments") == 1
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(other.tenant_id))
    assert await pg.fetchval("SELECT count(*) FROM service.appointments") == 0


async def test_linked_technician_requires_an_active_technician_membership(
    pg: asyncpg.Connection,
) -> None:
    fixture = await _tenant(pg, "Technician link", enabled=True)
    await _as_web(pg, fixture)
    with pytest.raises(asyncpg.CheckViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO service.technicians"
                "(tenant_id,linked_user_id,full_name,created_by_user_id) "
                "VALUES ($1,$2,'Invalid owner link',$2)",
                fixture.tenant_id,
                fixture.user_id,
            )

    await pg.execute("RESET ROLE")
    technician_user_id = uuid4()
    await pg.execute(
        "INSERT INTO users(id,email,status) VALUES ($1,$2,'active')",
        technician_user_id,
        f"{technician_user_id}@example.test",
    )
    await pg.execute(
        "INSERT INTO memberships(user_id,tenant_id,role) VALUES ($1,$2,'technician')",
        technician_user_id,
        fixture.tenant_id,
    )
    technician_id = await pg.fetchval(
        "INSERT INTO service.technicians"
        "(tenant_id,linked_user_id,full_name,created_by_user_id) "
        "VALUES ($1,$2,'Valid technician link',$3) RETURNING id",
        fixture.tenant_id,
        technician_user_id,
        fixture.user_id,
    )
    await pg.execute("UPDATE users SET status='disabled' WHERE id=$1", technician_user_id)
    await pg.execute("UPDATE service.technicians SET active=false WHERE id=$1", technician_id)
    with pytest.raises(asyncpg.CheckViolationError):
        async with pg.transaction():
            await pg.execute(
                "UPDATE service.technicians SET active=true WHERE id=$1", technician_id
            )


async def test_tenant_isolation_covers_evidence_identities_settings_and_exports(
    pg: asyncpg.Connection,
) -> None:
    first = await _tenant(pg, "Isolation first", enabled=True)
    second = await _tenant(pg, "Isolation second", enabled=True)

    async def records(fixture: TenantFixture, suffix: str) -> dict[str, UUID]:
        technician_id = await pg.fetchval(
            "INSERT INTO service.technicians"
            "(tenant_id,full_name,employee_identifier,created_by_user_id) "
            "VALUES ($1,$2,$3,$4) RETURNING id",
            fixture.tenant_id,
            f"Synthetic technician {suffix}",
            f"ISO-{suffix}",
            fixture.user_id,
        )
        case_id = await pg.fetchval(
            "INSERT INTO service.cases"
            "(tenant_id,reference,customer_contact_id,title,fault_description,"
            "created_by_user_id) VALUES ($1,$2,$3,'Synthetic case','Synthetic fault',$4) "
            "RETURNING id",
            fixture.tenant_id,
            f"FS-ISO-{suffix}",
            fixture.contact_id,
            fixture.user_id,
        )
        visit_id = await pg.fetchval(
            "INSERT INTO service.visits(tenant_id,case_id,technician_id,visit_number) "
            "VALUES ($1,$2,$3,1) RETURNING id",
            fixture.tenant_id,
            case_id,
            technician_id,
        )
        session_id = await _auth_session(
            pg, fixture.user_id, fixture.tenant_id, f"field-isolation-{suffix}"
        )
        identity_id = await pg.fetchval(
            "INSERT INTO service.technician_session_identities"
            "(tenant_id,auth_session_id,visit_id,technician_id,full_name,"
            "employee_identifier,server_nonce,expires_at) "
            "VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP + interval '1 hour') "
            "RETURNING id",
            fixture.tenant_id,
            session_id,
            visit_id,
            technician_id,
            f"Synthetic technician {suffix}",
            f"ISO-{suffix}",
            uuid4().hex,
        )
        object_id = await pg.fetchval(
            "INSERT INTO objects.object_metadata"
            "(tenant_id,owner_type,owner_id,category,content_type,byte_size,checksum,"
            "storage_backend,storage_key,status) "
            "VALUES ($1,'service_case',$2,'fault','image/png',9,$3,'local',$4,'available') "
            "RETURNING id",
            fixture.tenant_id,
            case_id,
            uuid4().hex + uuid4().hex,
            f"synthetic/{fixture.tenant_id}/{uuid4()}.png",
        )
        attachment_id = await pg.fetchval(
            "INSERT INTO service.report_attachments"
            "(tenant_id,case_id,visit_id,object_id,category,source) "
            "VALUES ($1,$2,$3,$4,'fault','technician') RETURNING id",
            fixture.tenant_id,
            case_id,
            visit_id,
            object_id,
        )
        export_id = await pg.fetchval(
            "INSERT INTO service.export_records"
            "(tenant_id,case_id,format,branding_snapshot,requested_by_user_id) "
            "VALUES ($1,$2,'pdf',jsonb_build_object('businessName',$3::text),$4) "
            "RETURNING id",
            fixture.tenant_id,
            case_id,
            f"Synthetic business {suffix}",
            fixture.user_id,
        )
        return {
            "identity": identity_id,
            "object": object_id,
            "attachment": attachment_id,
            "export": export_id,
        }

    own = await records(first, "ONE")
    foreign = await records(second, "TWO")
    await _as_web(pg, first)

    for query, key in (
        (
            "SELECT id FROM service.technician_session_identities WHERE id=$1",
            "identity",
        ),
        ("SELECT id FROM objects.object_metadata WHERE id=$1", "object"),
        ("SELECT id FROM service.report_attachments WHERE id=$1", "attachment"),
        ("SELECT id FROM service.export_records WHERE id=$1", "export"),
    ):
        assert await pg.fetchval(query, own[key]) == own[key]
        assert await pg.fetchval(query, foreign[key]) is None
    assert await pg.fetchval("SELECT count(*) FROM service.tenant_configuration") == 1
    assert await pg.fetchval("SELECT count(*) FROM platform.tenant_feature_entitlements") == 14
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM platform.tenant_feature_entitlements WHERE tenant_id=$1",
            second.tenant_id,
        )
        == 0
    )


async def test_intake_case_idempotency_allows_separate_requests(
    pg: asyncpg.Connection,
) -> None:
    fixture = await _tenant(pg, "Intake", enabled=True)
    channel_id = await pg.fetchval(
        "INSERT INTO messaging.channels"
        "(tenant_id,kind,provider,provider_account_id) "
        "VALUES ($1,'whatsapp','simulator',$2) RETURNING id",
        fixture.tenant_id,
        f"field-intake-{fixture.tenant_id}",
    )
    conversation_id = await pg.fetchval(
        "INSERT INTO messaging.conversations(tenant_id,channel_id,contact_id) "
        "VALUES ($1,$2,$3) RETURNING id",
        fixture.tenant_id,
        channel_id,
        fixture.contact_id,
    )
    first_intake = await pg.fetchval(
        "INSERT INTO service.intake_drafts"
        "(tenant_id,conversation_id,reporting_contact_id,correlation_key) "
        "VALUES ($1,$2,$3,'request-one') RETURNING id",
        fixture.tenant_id,
        conversation_id,
        fixture.contact_id,
    )
    first_case = await pg.fetchval(
        "INSERT INTO service.cases"
        "(tenant_id,reference,customer_contact_id,intake_draft_id,conversation_id,"
        "title,fault_description,source) "
        "VALUES ($1,'FS-INTAKE-1',$2,$3,$4,'First','First fault','whatsapp') "
        "RETURNING id",
        fixture.tenant_id,
        fixture.contact_id,
        first_intake,
        conversation_id,
    )
    with pytest.raises(asyncpg.UniqueViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO service.cases"
                "(tenant_id,reference,customer_contact_id,intake_draft_id,title,"
                "fault_description,source) VALUES "
                "($1,'FS-INTAKE-RETRY',$2,$3,'Retry','Retry','whatsapp')",
                fixture.tenant_id,
                fixture.contact_id,
                first_intake,
            )
    second_intake = await pg.fetchval(
        "INSERT INTO service.intake_drafts"
        "(tenant_id,conversation_id,reporting_contact_id,correlation_key) "
        "VALUES ($1,$2,$3,'request-two') RETURNING id",
        fixture.tenant_id,
        conversation_id,
        fixture.contact_id,
    )
    second_case = await pg.fetchval(
        "INSERT INTO service.cases"
        "(tenant_id,reference,customer_contact_id,intake_draft_id,conversation_id,"
        "title,fault_description,source) "
        "VALUES ($1,'FS-INTAKE-2',$2,$3,$4,'Second','Second fault','whatsapp') "
        "RETURNING id",
        fixture.tenant_id,
        fixture.contact_id,
        second_intake,
        conversation_id,
    )
    assert first_case != second_case


async def test_disabling_stops_new_summary_jobs_without_breaking_messages(
    pg: asyncpg.Connection,
) -> None:
    fixture = await _tenant(pg, "Disable worker", enabled=True)
    channel_id = await pg.fetchval(
        "INSERT INTO messaging.channels"
        "(tenant_id,kind,provider,provider_account_id) "
        "VALUES ($1,'whatsapp','simulator',$2) RETURNING id",
        fixture.tenant_id,
        f"field-worker-{fixture.tenant_id}",
    )
    conversation_id = await pg.fetchval(
        "INSERT INTO messaging.conversations(tenant_id,channel_id,contact_id) "
        "VALUES ($1,$2,$3) RETURNING id",
        fixture.tenant_id,
        channel_id,
        fixture.contact_id,
    )
    case_id = await pg.fetchval(
        "INSERT INTO service.cases"
        "(tenant_id,reference,customer_contact_id,conversation_id,title,fault_description) "
        "VALUES ($1,'FS-DISABLE-1',$2,$3,'Fault','Synthetic fault') RETURNING id",
        fixture.tenant_id,
        fixture.contact_id,
        conversation_id,
    )
    await pg.execute(
        "INSERT INTO service.case_conversations"
        "(tenant_id,case_id,conversation_id,relationship) "
        "VALUES ($1,$2,$3,'intake')",
        fixture.tenant_id,
        case_id,
        conversation_id,
    )
    queued_before = await pg.fetchval(
        "SELECT count(*) FROM ops.jobs WHERE tenant_id=$1 AND job_type='field_service.summary'",
        fixture.tenant_id,
    )
    await pg.execute(
        "UPDATE service.tenant_configuration SET enabled=false WHERE tenant_id=$1",
        fixture.tenant_id,
    )
    message_id = await pg.fetchval(
        "INSERT INTO messaging.messages"
        "(tenant_id,conversation_id,direction,sender_type,content_type,content_text,provider) "
        "VALUES ($1,$2,'inbound','contact','text','Still retained','simulator') "
        "RETURNING id",
        fixture.tenant_id,
        conversation_id,
    )
    assert message_id is not None
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM ops.jobs WHERE tenant_id=$1 AND job_type='field_service.summary'",
            fixture.tenant_id,
        )
        == queued_before
    )


async def test_shared_sessions_cannot_replace_signed_attendance_or_final_reports(
    pg: asyncpg.Connection,
) -> None:
    fixture = await _tenant(pg, "Shared technician", enabled=True)
    shared_user_id = uuid4()
    await pg.execute(
        "INSERT INTO users(id,email,status) VALUES ($1,$2,'active')",
        shared_user_id,
        f"{shared_user_id}@example.test",
    )
    await pg.execute(
        "INSERT INTO memberships(user_id,tenant_id,role) VALUES ($1,$2,'technician')",
        shared_user_id,
        fixture.tenant_id,
    )
    await pg.execute(
        "UPDATE service.tenant_configuration "
        "SET shared_technician_login_enabled=true WHERE tenant_id=$1",
        fixture.tenant_id,
    )
    technician_id = await pg.fetchval(
        "INSERT INTO service.technicians"
        "(tenant_id,full_name,employee_identifier,created_by_user_id) "
        "VALUES ($1,'Synthetic Field Technician','FIELD-01',$2) RETURNING id",
        fixture.tenant_id,
        fixture.user_id,
    )
    case_id = await pg.fetchval(
        "INSERT INTO service.cases"
        "(tenant_id,reference,customer_contact_id,title,fault_description,created_by_user_id) "
        "VALUES ($1,'FS-SIGNED-1',$2,'Synthetic fault','Evidence-only fixture',$3) "
        "RETURNING id",
        fixture.tenant_id,
        fixture.contact_id,
        fixture.user_id,
    )
    visit_id = await pg.fetchval(
        "INSERT INTO service.visits(tenant_id,case_id,technician_id,visit_number) "
        "VALUES ($1,$2,$3,1) RETURNING id",
        fixture.tenant_id,
        case_id,
        technician_id,
    )

    async def evidence(category: str) -> UUID:
        object_id = await pg.fetchval(
            "INSERT INTO objects.object_metadata"
            "(tenant_id,owner_type,owner_id,category,content_type,byte_size,checksum,"
            "storage_backend,storage_key,status) "
            "VALUES ($1,'service_case',$2,$3,'image/png',9,$4,'local',$5,'available') "
            "RETURNING id",
            fixture.tenant_id,
            case_id,
            category,
            uuid4().hex + uuid4().hex,
            f"synthetic/{fixture.tenant_id}/{uuid4()}.png",
        )
        await pg.execute(
            "INSERT INTO service.report_attachments"
            "(tenant_id,case_id,visit_id,object_id,category,source) "
            "VALUES ($1,$2,$3,$4,$5,'technician')",
            fixture.tenant_id,
            case_id,
            visit_id,
            object_id,
            category,
        )
        return object_id

    arrival_object = await evidence("arrival_signature")
    departure_object = await evidence("departure_signature")
    replacement_object = await evidence("arrival_signature")
    first_session = await _auth_session(
        pg, shared_user_id, fixture.tenant_id, "field-service-shared-a"
    )
    second_session = await _auth_session(
        pg, shared_user_id, fixture.tenant_id, "field-service-shared-b"
    )

    await pg.execute("SET LOCAL ROLE platform_web")
    await pg.execute(
        "SELECT set_config('app.current_tenant',$1,true),"
        "set_config('app.current_user',$2,true),"
        "set_config('app.current_role','technician',true),"
        "set_config('app.current_session',$3,true)",
        str(fixture.tenant_id),
        str(shared_user_id),
        str(first_session),
    )
    # A shared account reaches field work only after each browser session
    # names its physical technician; both sessions here are the same person.
    await pg.fetchval(
        "SELECT service.bind_current_technician_session($1,'FIELD-01','bind-shared-a')",
        technician_id,
    )
    first_identity = await pg.fetchval(
        "INSERT INTO service.technician_session_identities"
        "(tenant_id,auth_session_id,visit_id,technician_id,full_name,"
        "employee_identifier,server_nonce,expires_at) "
        "VALUES ($1,$2,$3,$4,'Synthetic Field Technician','FIELD-01',$5,"
        "CURRENT_TIMESTAMP + interval '1 hour') RETURNING id",
        fixture.tenant_id,
        first_session,
        visit_id,
        technician_id,
        uuid4().hex,
    )
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO service.technician_session_identities"
                "(tenant_id,auth_session_id,visit_id,technician_id,full_name,"
                "employee_identifier,server_nonce,expires_at) "
                "VALUES ($1,$2,$3,$4,'Synthetic Field Technician','FIELD-01',$5,"
                "CURRENT_TIMESTAMP + interval '1 hour')",
                fixture.tenant_id,
                second_session,
                visit_id,
                technician_id,
                uuid4().hex,
            )

    with pytest.raises(asyncpg.CheckViolationError):
        async with pg.transaction():
            await pg.execute(
                "UPDATE service.visits SET departure_at='2026-09-14T10:00:00Z',"
                "departure_signature_object_id=$1,departure_identity=$2::jsonb "
                "WHERE id=$3",
                departure_object,
                '{"fullName":"Synthetic Field Technician"}',
                visit_id,
            )
    arrival_identity = (
        '{"identityId":"' + str(first_identity) + '","fullName":"Synthetic Field Technician",'
        '"verificationState":"self_declared"}'
    )
    await pg.execute(
        "UPDATE service.visits SET arrival_at='2026-09-14T09:00:00Z',"
        "arrival_signature_object_id=$1,arrival_identity=$2::jsonb,status='arrived' "
        "WHERE id=$3",
        arrival_object,
        arrival_identity,
        visit_id,
    )
    await pg.execute("SELECT set_config('app.current_session',$1,true)", str(second_session))
    await pg.fetchval(
        "SELECT service.bind_current_technician_session($1,'FIELD-01','bind-shared-b')",
        technician_id,
    )
    with pytest.raises(asyncpg.ObjectNotInPrerequisiteStateError):
        async with pg.transaction():
            await pg.execute(
                "UPDATE service.visits SET arrival_signature_object_id=$1,"
                "arrival_identity=$2::jsonb WHERE id=$3",
                replacement_object,
                '{"fullName":"Replacement"}',
                visit_id,
            )
    await pg.execute(
        "UPDATE service.visits SET departure_at='2026-09-14T10:00:00Z',"
        "departure_signature_object_id=$1,departure_identity=$2::jsonb,status='departed' "
        "WHERE id=$3",
        departure_object,
        arrival_identity,
        visit_id,
    )
    assert (
        await pg.fetchval(
            "SELECT extract(epoch FROM departure_at-arrival_at)::int "
            "FROM service.visits WHERE id=$1",
            visit_id,
        )
        == 3600
    )

    report_id = await pg.fetchval(
        "INSERT INTO service.reports(tenant_id,case_id,visit_id) VALUES ($1,$2,$3) RETURNING id",
        fixture.tenant_id,
        case_id,
        visit_id,
    )
    revision_id = await pg.fetchval(
        "INSERT INTO service.report_revisions"
        "(tenant_id,report_id,version,status,diagnosis,work_performed,part_replaced,"
        "branding_snapshot,finalized_at,finalized_by_user_id) "
        "VALUES ($1,$2,1,'finalized','Synthetic diagnosis','Synthetic repair',false,"
        "$3::jsonb,CURRENT_TIMESTAMP,$4) RETURNING id",
        fixture.tenant_id,
        report_id,
        '{"businessName":"Synthetic Tenant"}',
        shared_user_id,
    )
    with pytest.raises(asyncpg.ObjectNotInPrerequisiteStateError):
        async with pg.transaction():
            await pg.execute(
                "UPDATE service.report_revisions SET diagnosis='Silent mutation' WHERE id=$1",
                revision_id,
            )
    await pg.execute(
        "UPDATE service.report_revisions SET status='superseded' WHERE id=$1", revision_id
    )
    correction_id = await pg.fetchval(
        "INSERT INTO service.report_revisions"
        "(tenant_id,report_id,version,status,supersedes_revision_id,created_by_user_id) "
        "VALUES ($1,$2,2,'draft',$3,$4) RETURNING id",
        fixture.tenant_id,
        report_id,
        revision_id,
        shared_user_id,
    )
    assert correction_id != revision_id
