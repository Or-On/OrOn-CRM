"""One shared technician account, many simultaneous sessions, one physical
technician per session.

The shared platform user never identifies who does field work. Each
authenticated browser session binds its own physical technician, and every
case, visit, report, queue and claim decision resolves that technician from
the exact transaction-local session.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import asyncpg
import pytest

from db.tests.postgres.conftest import run_alembic
from db.tests.postgres.test_field_service import TenantFixture, _tenant

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]

SELF_ASSIGNMENT_POLICY = {
    "version": 1,
    "requiredIntakeFields": ["faultDescription"],
    "photoPolicy": "optional",
    "selfAssignmentEnabled": True,
    "requiredReportFields": ["diagnosis", "workPerformed"],
}


@dataclass(frozen=True)
class SharedTechnicians:
    tenant: TenantFixture
    shared_user: UUID
    linked_user: UUID
    david: UUID
    moshe: UUID
    sarah: UUID
    linked: UUID
    session_a: UUID
    session_b: UUID
    session_c: UUID
    token_a: bytes
    token_b: bytes


async def _session(
    pg: asyncpg.Connection, user_id: UUID, tenant_id: UUID, label: str
) -> tuple[UUID, bytes]:
    """Create one browser session exactly as the login path does."""

    token_hash = uuid4().bytes + uuid4().bytes
    now = datetime.now(UTC)
    session_id = await pg.fetchval(
        "SELECT platform.auth_create_session($1,$2,$3,$4,43200,$5,$6,NULL,NULL,$7)",
        user_id,
        tenant_id,
        token_hash,
        uuid4().bytes + uuid4().bytes,
        now + timedelta(hours=12),
        now + timedelta(days=7),
        label,
    )
    return session_id, token_hash


async def _shared_technicians(pg: asyncpg.Connection, name: str) -> SharedTechnicians:
    tenant = await _tenant(pg, name, enabled=True)
    await pg.execute(
        "UPDATE platform.tenant_feature_entitlements SET configuration=$2::jsonb "
        "WHERE tenant_id=$1 AND feature_key='field_service'",
        tenant.tenant_id,
        json.dumps({"workflow": SELF_ASSIGNMENT_POLICY}),
    )
    await pg.execute(
        "UPDATE service.tenant_configuration SET shared_technician_login_enabled=true "
        "WHERE tenant_id=$1",
        tenant.tenant_id,
    )
    shared_user = uuid4()
    linked_user = uuid4()
    await pg.execute(
        "INSERT INTO users(id,email,display_name,status) VALUES "
        "($1,$2,'Shared technicians','active'),($3,$4,'Linked technician','active')",
        shared_user,
        f"technicians-{shared_user}@example.test",
        linked_user,
        f"linked-{linked_user}@example.test",
    )
    await pg.execute(
        "INSERT INTO memberships(user_id,tenant_id,role) VALUES "
        "($1,$3,'technician'),($2,$3,'technician')",
        shared_user,
        linked_user,
        tenant.tenant_id,
    )

    async def technician(full_name: str, identifier: str | None, user: UUID | None) -> UUID:
        return await pg.fetchval(
            "INSERT INTO service.technicians"
            "(tenant_id,full_name,employee_identifier,linked_user_id,created_by_user_id) "
            "VALUES ($1,$2,$3,$4,$5) RETURNING id",
            tenant.tenant_id,
            full_name,
            identifier,
            user,
            tenant.user_id,
        )

    david = await technician("David Fixture", "FS-DAVID", None)
    moshe = await technician("Moshe Fixture", "FS-MOSHE", None)
    sarah = await technician("Sarah Fixture", None, None)
    linked = await technician("Linked Fixture", "FS-LINKED", linked_user)
    session_a, token_a = await _session(pg, shared_user, tenant.tenant_id, "tablet-a")
    session_b, token_b = await _session(pg, shared_user, tenant.tenant_id, "tablet-b")
    session_c, _ = await _session(pg, shared_user, tenant.tenant_id, "tablet-c")
    return SharedTechnicians(
        tenant,
        shared_user,
        linked_user,
        david,
        moshe,
        sarah,
        linked,
        session_a,
        session_b,
        session_c,
        token_a,
        token_b,
    )


async def _as(
    pg: asyncpg.Connection,
    fixture: SharedTechnicians,
    session: UUID | None,
    *,
    user: UUID | None = None,
    role: str = "technician",
) -> None:
    await pg.execute("SET LOCAL ROLE platform_web")
    await pg.execute(
        "SELECT set_config('app.current_tenant',$1,true),"
        "set_config('app.current_user',$2,true),"
        "set_config('app.current_role',$3,true),"
        "set_config('app.current_session',$4,true)",
        str(fixture.tenant.tenant_id),
        str(user or fixture.shared_user),
        role,
        "" if session is None else str(session),
    )


async def _bind(
    pg: asyncpg.Connection, full_name: str, identifier: str, phone: str | None = None
) -> dict:
    """Identify exactly as the shared device does: typed details only."""

    return json.loads(
        await pg.fetchval(
            "SELECT service.bind_current_technician_session($1,$2,$3,$4)",
            full_name,
            identifier,
            phone,
            f"bind-{uuid4()}",
        )
    )


async def _raises(pg: asyncpg.Connection, sqlstate: str, query: str, *args: object) -> str:
    with pytest.raises(asyncpg.PostgresError) as failure:
        async with pg.transaction():
            await pg.execute(query, *args)
    assert failure.value.sqlstate == sqlstate, failure.value
    return str(failure.value)


async def _case(pg: asyncpg.Connection, fixture: SharedTechnicians, title: str) -> UUID:
    return await pg.fetchval(
        "INSERT INTO service.cases"
        "(tenant_id,reference,customer_contact_id,title,fault_description,created_by_user_id) "
        "VALUES ($1,$2,$3,$4,'Synthetic fault',$5) RETURNING id",
        fixture.tenant.tenant_id,
        f"FS-SESSION-{uuid4().hex[:8]}",
        fixture.tenant.contact_id,
        title,
        fixture.tenant.user_id,
    )


async def _visit(
    pg: asyncpg.Connection, fixture: SharedTechnicians, case_id: UUID, technician: UUID
) -> UUID:
    await pg.execute(
        "UPDATE service.cases SET assigned_technician_id=$2 WHERE id=$1", case_id, technician
    )
    return await pg.fetchval(
        "INSERT INTO service.visits(tenant_id,case_id,technician_id,visit_number) "
        "SELECT $1,$2,$3,coalesce(max(visit_number),0)+1 FROM service.visits "
        "WHERE case_id=$2 RETURNING id",
        fixture.tenant.tenant_id,
        case_id,
        technician,
    )


async def test_one_account_keeps_independent_sessions_across_login_and_logout(
    pg: asyncpg.Connection,
) -> None:
    fixture = await _shared_technicians(pg, "Independent login sessions")

    # A second and third login never revoke the first: there is no single
    # active session per user and no logout-all side effect.
    resolved = {
        token: await pg.fetchrow("SELECT * FROM platform.auth_resolve_session($1)", token)
        for token in (fixture.token_a, fixture.token_b)
    }
    assert resolved[fixture.token_a]["session_id"] == fixture.session_a
    assert resolved[fixture.token_b]["session_id"] == fixture.session_b
    assert {row["user_id"] for row in resolved.values()} == {fixture.shared_user}
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM platform.auth_sessions WHERE user_id=$1 AND revoked_at IS NULL",
            fixture.shared_user,
        )
        == 3
    )

    # Logout revokes only the presenting session.
    assert await pg.fetchval(
        "SELECT platform.auth_revoke_session($1,'user_logout','logout-a')", fixture.token_a
    )
    assert (
        await pg.fetchrow("SELECT * FROM platform.auth_resolve_session($1)", fixture.token_a)
        is None
    )
    still_valid = await pg.fetchrow(
        "SELECT * FROM platform.auth_resolve_session($1)", fixture.token_b
    )
    assert still_valid is not None and still_valid["session_id"] == fixture.session_b
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM platform.auth_sessions WHERE user_id=$1 AND revoked_at IS NULL",
            fixture.shared_user,
        )
        == 2
    )


async def test_each_session_binds_its_own_physical_technician(pg: asyncpg.Connection) -> None:
    fixture = await _shared_technicians(pg, "Session-bound technicians")

    await _as(pg, fixture, fixture.session_a)
    assert await pg.fetchval("SELECT service.current_technician_session_mode()") == "shared"
    assert await pg.fetchval("SELECT service.current_session_technician_id()") is None
    # An employee identifier already held by another technician is refused.
    await _raises(
        pg,
        "FS401",
        "SELECT service.bind_current_technician_session($1,$2,NULL,'wrong-name')",
        "Moshe Fixture",
        "FS-DAVID",
    )
    # A profile linked to an individual account keeps its own sign-in.
    await _raises(
        pg,
        "FS403",
        "SELECT service.bind_current_technician_session($1,$2,NULL,'linked')",
        "Linked Fixture",
        "FS-LINKED",
    )
    # A technician a manager deactivated cannot re-register the same identifier.
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE service.technicians SET active=false, identity_verification='revoked' WHERE id=$1",
        fixture.sarah,
    )
    await pg.execute(
        "UPDATE service.technicians SET employee_identifier='FS-SARAH' WHERE id=$1",
        fixture.sarah,
    )
    await _as(pg, fixture, fixture.session_a)
    await _raises(
        pg,
        "FS403",
        "SELECT service.bind_current_technician_session($1,$2,NULL,'revoked')",
        "Sarah Fixture",
        "FS-SARAH",
    )
    # Details are validated before anything is recorded.
    for name, identifier in (("D", "FS-DAVID"), ("David Fixture", "!!")):
        await _raises(
            pg,
            "22023",
            "SELECT service.bind_current_technician_session($1,$2,NULL,'invalid')",
            name,
            identifier,
        )
    bound = await _bind(pg, "  David Fixture ", "  fs-david ")
    assert bound["technicianId"] == str(fixture.david)
    assert bound["fullName"] == "David Fixture"
    assert bound["profileCreated"] is False
    assert await pg.fetchval("SELECT service.current_session_technician_id()") == fixture.david
    # Repeating the same identification is idempotent.
    assert (await _bind(pg, "David Fixture", "FS-DAVID"))["technicianId"] == str(fixture.david)

    await _as(pg, fixture, fixture.session_b)
    assert await pg.fetchval("SELECT service.current_session_technician_id()") is None
    await _bind(pg, "Moshe Fixture", "FS-MOSHE")
    assert await pg.fetchval("SELECT service.current_session_technician_id()") == fixture.moshe
    # Session B only sees its own binding row.
    assert await pg.fetchval("SELECT count(*) FROM service.technician_session_bindings") == 1
    assert (
        await pg.fetchval("SELECT technician_id FROM service.technician_session_bindings")
        == fixture.moshe
    )

    await _as(pg, fixture, fixture.session_a)
    assert await pg.fetchval("SELECT service.current_session_technician_id()") == fixture.david
    # A bound session must release before another person identifies on it.
    await _raises(
        pg,
        "FS409",
        "SELECT service.bind_current_technician_session($1,$2,NULL,'switch')",
        "Moshe Fixture",
        "FS-MOSHE",
    )
    # Runtime roles cannot write bindings directly; only the definer functions can.
    await _raises(
        pg,
        "42501",
        "UPDATE service.technician_session_bindings SET technician_id=$1",
        fixture.moshe,
    )
    assert await pg.fetchval("SELECT service.release_current_technician_session('handover')")
    assert await pg.fetchval("SELECT service.current_session_technician_id()") is None
    # A technician with no profile yet self-registers from the same form.
    handover = await _bind(pg, "Yossi Fixture", "FS-YOSSI", "+972500000000")
    assert handover["profileCreated"] is True
    assert handover["identityVerification"] == "self_declared"
    assert await pg.fetchval("SELECT service.current_session_technician_id()") == UUID(
        handover["technicianId"]
    )

    await _as(pg, fixture, fixture.session_b)
    assert await pg.fetchval("SELECT service.current_session_technician_id()") == fixture.moshe

    # Only technician sessions of a shared account can bind a technician.
    await _as(pg, fixture, None, user=fixture.tenant.user_id, role="owner")
    await _raises(
        pg,
        "42501",
        "SELECT service.bind_current_technician_session($1,$2,NULL,'owner')",
        "David Fixture",
        "FS-DAVID",
    )
    linked_session, _ = await _session_as_superuser(pg, fixture.linked_user, fixture)
    await _as(pg, fixture, linked_session, user=fixture.linked_user)
    assert await pg.fetchval("SELECT service.current_technician_session_mode()") == "individual"
    assert await pg.fetchval("SELECT service.current_session_technician_id()") == fixture.linked
    await _raises(
        pg,
        "42501",
        "SELECT service.bind_current_technician_session($1,$2,NULL,'linked-account')",
        "David Fixture",
        "FS-DAVID",
    )

    await pg.execute("RESET ROLE")
    audit = await pg.fetch(
        "SELECT action, target_id, metadata->>'authSessionId' AS session "
        "FROM audit.records WHERE tenant_id=$1 "
        "AND action LIKE 'field_service.technician_session.%'",
        fixture.tenant.tenant_id,
    )
    # One transaction shares one timestamp, so compare the audit trail as a set.
    assert sorted(
        (row["action"], str(row["target_id"]), row["session"]) for row in audit
    ) == sorted(
        [
            ("field_service.technician_session.bound", str(fixture.david), str(fixture.session_a)),
            ("field_service.technician_session.bound", str(fixture.moshe), str(fixture.session_b)),
            (
                "field_service.technician_session.released",
                str(fixture.david),
                str(fixture.session_a),
            ),
            (
                "field_service.technician_session.bound",
                handover["technicianId"],
                str(fixture.session_a),
            ),
        ]
    )
    # The self-registered profile is recorded as a self-declared technician.
    registration = await pg.fetchrow(
        "SELECT technician.full_name, technician.employee_identifier, technician.phone,"
        "technician.identity_verification, technician.created_by_user_id,"
        "record.metadata->>'origin' AS origin "
        "FROM service.technicians technician "
        "JOIN audit.records record ON record.target_id=technician.id "
        "AND record.action='field_service.technician.created' "
        "WHERE technician.id=$1",
        UUID(handover["technicianId"]),
    )
    assert registration is not None
    assert registration["full_name"] == "Yossi Fixture"
    assert registration["employee_identifier"] == "FS-YOSSI"
    assert registration["phone"] == "+972500000000"
    assert registration["identity_verification"] == "self_declared"
    assert registration["created_by_user_id"] == fixture.shared_user
    assert registration["origin"] == "shared_session_identification"


async def _session_as_superuser(
    pg: asyncpg.Connection, user_id: UUID, fixture: SharedTechnicians
) -> tuple[UUID, bytes]:
    await pg.execute("RESET ROLE")
    return await _session(pg, user_id, fixture.tenant.tenant_id, f"session-{uuid4()}")


async def test_binding_lapses_with_its_session_profile_or_shared_login(
    pg: asyncpg.Connection,
) -> None:
    fixture = await _shared_technicians(pg, "Binding lifetime")
    await _as(pg, fixture, fixture.session_a)
    await _bind(pg, "David Fixture", "FS-DAVID")
    await _as(pg, fixture, fixture.session_b)
    await _bind(pg, "Moshe Fixture", "FS-MOSHE")

    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE platform.auth_sessions SET revoked_at=clock_timestamp(),"
        "revocation_reason='user_logout' WHERE id=$1",
        fixture.session_a,
    )
    await _as(pg, fixture, fixture.session_a)
    assert await pg.fetchval("SELECT service.current_session_technician_id()") is None
    await _as(pg, fixture, fixture.session_b)
    assert await pg.fetchval("SELECT service.current_session_technician_id()") == fixture.moshe

    # Another technician account cannot borrow a binding by naming its session.
    other_account = uuid4()
    await pg.execute("RESET ROLE")
    await pg.execute(
        "INSERT INTO users(id,email,status) VALUES ($1,$2,'active')",
        other_account,
        f"other-{other_account}@example.test",
    )
    await pg.execute(
        "INSERT INTO memberships(user_id,tenant_id,role) VALUES ($1,$2,'technician')",
        other_account,
        fixture.tenant.tenant_id,
    )
    await _as(pg, fixture, fixture.session_b, user=other_account)
    assert await pg.fetchval("SELECT service.current_session_technician_id()") is None
    assert await pg.fetchval("SELECT count(*) FROM service.technician_session_bindings") == 0
    assert await pg.fetchval("SELECT count(*) FROM service.cases") == 0

    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE service.tenant_configuration SET shared_technician_login_enabled=false "
        "WHERE tenant_id=$1",
        fixture.tenant.tenant_id,
    )
    await _as(pg, fixture, fixture.session_b)
    assert await pg.fetchval("SELECT service.current_technician_session_mode()") == "unlinked"
    assert await pg.fetchval("SELECT service.current_session_technician_id()") is None

    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE service.tenant_configuration SET shared_technician_login_enabled=true "
        "WHERE tenant_id=$1",
        fixture.tenant.tenant_id,
    )
    await _as(pg, fixture, fixture.session_b)
    assert await pg.fetchval("SELECT service.current_session_technician_id()") == fixture.moshe
    await pg.execute("RESET ROLE")
    await pg.execute("UPDATE service.technicians SET active=false WHERE id=$1", fixture.moshe)
    await _as(pg, fixture, fixture.session_b)
    assert await pg.fetchval("SELECT service.current_session_technician_id()") is None


async def test_queue_rls_and_claims_follow_the_session_technician(
    pg: asyncpg.Connection,
) -> None:
    fixture = await _shared_technicians(pg, "Session queue")
    david_case = await _case(pg, fixture, "David assigned work")
    moshe_case = await _case(pg, fixture, "Moshe assigned work")
    open_case = await _case(pg, fixture, "Unassigned incident")
    david_visit = await _visit(pg, fixture, david_case, fixture.david)
    moshe_visit = await _visit(pg, fixture, moshe_case, fixture.moshe)

    await _as(pg, fixture, fixture.session_a)
    await _bind(pg, "David Fixture", "FS-DAVID")
    await _as(pg, fixture, fixture.session_b)
    await _bind(pg, "Moshe Fixture", "FS-MOSHE")

    async def visible(session: UUID) -> dict[str, set[UUID]]:
        await _as(pg, fixture, session)
        mine = {
            UUID(json.loads(row[0])["id"])
            for row in await pg.fetch("SELECT * FROM service.list_assignment_queue('mine')")
        }
        return {
            "mine": mine,
            "cases": {row["id"] for row in await pg.fetch("SELECT id FROM service.cases")},
            "visits": {row["id"] for row in await pg.fetch("SELECT id FROM service.visits")},
            "technicians": {
                row["id"] for row in await pg.fetch("SELECT id FROM service.technicians")
            },
        }

    # Same tenant, same platform user, different sessions: different work.
    assert await visible(fixture.session_a) == {
        "mine": {david_case},
        "cases": {david_case},
        "visits": {david_visit},
        "technicians": {fixture.david},
    }
    assert await visible(fixture.session_b) == {
        "mine": {moshe_case},
        "cases": {moshe_case},
        "visits": {moshe_visit},
        "technicians": {fixture.moshe},
    }

    # An unidentified session of the shared account sees no field work at all.
    await _as(pg, fixture, fixture.session_c)
    assert await pg.fetchval("SELECT count(*) FROM service.cases") == 0
    assert await pg.fetchval("SELECT count(*) FROM service.visits") == 0
    await _raises(pg, "FS428", "SELECT * FROM service.list_assignment_queue('mine')")
    await _raises(pg, "FS428", "SELECT service.assign_case($1,NULL,NULL)", open_case)

    await _as(pg, fixture, fixture.session_a)
    available = [
        json.loads(row[0])["id"]
        for row in await pg.fetch("SELECT * FROM service.list_assignment_queue('available')")
    ]
    assert available == [str(open_case)]
    receipt = json.loads(await pg.fetchval("SELECT service.assign_case($1,NULL,NULL)", open_case))
    assert receipt["technicianId"] == str(fixture.david)
    # The browser cannot pick a technician: the manager path needs a manager.
    await _raises(
        pg,
        "42501",
        "SELECT service.assign_case($1,$2,'Move to Moshe')",
        david_case,
        fixture.moshe,
    )

    await _as(pg, fixture, fixture.session_b)
    await _raises(pg, "40001", "SELECT service.assign_case($1,NULL,NULL)", open_case)
    assert await pg.fetchval("SELECT count(*) FROM service.cases WHERE id=$1", open_case) == 0

    await pg.execute("RESET ROLE")
    claimed = await pg.fetchrow(
        "SELECT assigned_technician_id FROM service.cases WHERE id=$1", open_case
    )
    assert claimed["assigned_technician_id"] == fixture.david
    visits = await pg.fetch(
        "SELECT technician_id, status FROM service.visits WHERE case_id=$1", open_case
    )
    assert [(row["technician_id"], row["status"]) for row in visits] == [
        (fixture.david, "assigned")
    ]
    audit = await pg.fetchrow(
        "SELECT actor_user_id, metadata FROM audit.records "
        "WHERE target_id=$1 AND action='field_service.case.claimed'",
        open_case,
    )
    metadata = json.loads(audit["metadata"])
    assert audit["actor_user_id"] == fixture.shared_user
    assert metadata["technicianId"] == str(fixture.david)
    assert metadata["authSessionId"] == str(fixture.session_a)
    assert metadata["origin"] == "queue_claim"

    # Individually linked technician accounts keep working unchanged.
    linked_session, _ = await _session_as_superuser(pg, fixture.linked_user, fixture)
    linked_case = await _case(pg, fixture, "Linked account work")
    await _visit(pg, fixture, linked_case, fixture.linked)
    await _as(pg, fixture, linked_session, user=fixture.linked_user)
    assert [
        json.loads(row[0])["id"]
        for row in await pg.fetch("SELECT * FROM service.list_assignment_queue('mine')")
    ] == [str(linked_case)]


async def test_technician_created_cases_belong_to_the_sessions_technician(
    pg: asyncpg.Connection,
) -> None:
    fixture = await _shared_technicians(pg, "Technician case creation")
    await _as(pg, fixture, fixture.session_a)
    await _bind(pg, "David Fixture", "FS-DAVID")
    await _as(pg, fixture, fixture.session_b)
    await _bind(pg, "Moshe Fixture", "FS-MOSHE")

    create = (
        "SELECT service.create_technician_case($1,NULL,$2,'Synthetic fault',"
        "'unknown',NULL,'Model X','SN-1','normal',$3)"
    )
    await _as(pg, fixture, fixture.session_a)
    david_receipt = json.loads(
        await pg.fetchval(create, fixture.tenant.contact_id, "David created", "create-a")
    )
    await _as(pg, fixture, fixture.session_b)
    moshe_receipt = json.loads(
        await pg.fetchval(create, fixture.tenant.contact_id, "Moshe created", "create-b")
    )
    assert david_receipt["technicianId"] == str(fixture.david)
    assert moshe_receipt["technicianId"] == str(fixture.moshe)
    assert david_receipt["reference"].startswith("FS-")

    # Each session reaches only the case its own technician created.
    assert {row["id"] for row in await pg.fetch("SELECT id FROM service.cases")} == {
        UUID(moshe_receipt["caseId"])
    }
    await _as(pg, fixture, fixture.session_a)
    assert {row["id"] for row in await pg.fetch("SELECT id FROM service.cases")} == {
        UUID(david_receipt["caseId"])
    }

    # An unidentified session and a non-technician cannot use this path.
    await _as(pg, fixture, fixture.session_c)
    await _raises(pg, "FS428", create, fixture.tenant.contact_id, "Nobody", "create-c")
    await _as(pg, fixture, None, user=fixture.tenant.user_id, role="owner")
    await _raises(pg, "42501", create, fixture.tenant.contact_id, "Owner", "create-owner")

    await pg.execute("RESET ROLE")
    rows = await pg.fetch(
        "SELECT service_case.id, service_case.created_by_user_id, service_case.source,"
        "service_case.status, service_case.assigned_technician_id, visit.technician_id,"
        "visit.visit_number, service_case.tenant_id "
        "FROM service.cases service_case "
        "JOIN service.visits visit ON visit.case_id=service_case.id "
        "WHERE service_case.id = ANY($1::uuid[]) ORDER BY service_case.title",
        [UUID(david_receipt["caseId"]), UUID(moshe_receipt["caseId"])],
    )
    assert [
        (
            row["created_by_user_id"],
            row["source"],
            row["status"],
            row["assigned_technician_id"],
            row["technician_id"],
            row["visit_number"],
            row["tenant_id"],
        )
        for row in rows
    ] == [
        (
            fixture.shared_user,
            "manual",
            "awaiting_scheduling",
            fixture.david,
            fixture.david,
            1,
            fixture.tenant.tenant_id,
        ),
        (
            fixture.shared_user,
            "manual",
            "awaiting_scheduling",
            fixture.moshe,
            fixture.moshe,
            1,
            fixture.tenant.tenant_id,
        ),
    ]
    created = await pg.fetchrow(
        "SELECT request_id, metadata FROM audit.records "
        "WHERE target_id=$1 AND action='field_service.case.created'",
        UUID(david_receipt["caseId"]),
    )
    assert created["request_id"] == "create-a"
    assert json.loads(created["metadata"])["authSessionId"] == str(fixture.session_a)
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM service.case_status_history WHERE case_id=$1",
            UUID(david_receipt["caseId"]),
        )
        == 1
    )
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM support.tickets WHERE service_case_id=$1",
            UUID(david_receipt["caseId"]),
        )
        == 1
    )

    # A location of another customer is rejected just like the manager path.
    foreign_contact = await pg.fetchval(
        "INSERT INTO crm.contacts(tenant_id,name) VALUES ($1,'Other customer') RETURNING id",
        fixture.tenant.tenant_id,
    )
    foreign_location = await pg.fetchval(
        "INSERT INTO crm.service_locations(tenant_id,customer_contact_id,name) "
        "VALUES ($1,$2,'Other site') RETURNING id",
        fixture.tenant.tenant_id,
        foreign_contact,
    )
    await _as(pg, fixture, fixture.session_a)
    await _raises(
        pg,
        "22023",
        "SELECT service.create_technician_case($1,$2,'Wrong site','Fault','unknown',"
        "NULL,NULL,NULL,'normal','wrong-site')",
        fixture.tenant.contact_id,
        foreign_location,
    )


async def test_reports_are_tenant_records_worked_only_by_the_visit_technician(
    pg: asyncpg.Connection,
) -> None:
    fixture = await _shared_technicians(pg, "Session report ownership")
    shared_case = await _case(pg, fixture, "Repeat visit case")
    david_visit = await _visit(pg, fixture, shared_case, fixture.david)
    moshe_visit = await _visit(pg, fixture, shared_case, fixture.moshe)
    object_id = await pg.fetchval(
        "INSERT INTO objects.object_metadata"
        "(tenant_id,owner_type,owner_id,category,content_type,byte_size,checksum,"
        "storage_backend,storage_key,status) "
        "VALUES ($1,'service_case',$2,'fault','image/png',9,$3,'local',$4,'available') "
        "RETURNING id",
        fixture.tenant.tenant_id,
        shared_case,
        uuid4().hex + uuid4().hex,
        f"synthetic/{fixture.tenant.tenant_id}/{uuid4()}.png",
    )

    await _as(pg, fixture, fixture.session_a)
    await _bind(pg, "David Fixture", "FS-DAVID")
    david_report = await pg.fetchval(
        "INSERT INTO service.reports(tenant_id,case_id,visit_id) VALUES ($1,$2,$3) RETURNING id",
        fixture.tenant.tenant_id,
        shared_case,
        david_visit,
    )
    david_revision = await pg.fetchval(
        "INSERT INTO service.report_revisions(tenant_id,report_id,version,created_by_user_id) "
        "VALUES ($1,$2,1,$3) RETURNING id",
        fixture.tenant.tenant_id,
        david_report,
        fixture.shared_user,
    )
    assert await pg.fetchval(
        "UPDATE service.report_revisions SET diagnosis='David diagnosis' WHERE id=$1 RETURNING id",
        david_revision,
    )

    await _as(pg, fixture, fixture.session_b)
    await _bind(pg, "Moshe Fixture", "FS-MOSHE")
    # Moshe shares the case, so he may read its history...
    assert (
        await pg.fetchval(
            "SELECT diagnosis FROM service.report_revisions WHERE id=$1", david_revision
        )
        == "David diagnosis"
    )
    # ...but cannot alter David's report, visit, identity or evidence.
    assert (
        await pg.fetchval(
            "UPDATE service.report_revisions SET diagnosis='Overwritten' WHERE id=$1 RETURNING id",
            david_revision,
        )
        is None
    )
    assert (
        await pg.fetchval(
            "UPDATE service.reports SET deleted_at=clock_timestamp() WHERE id=$1 RETURNING id",
            david_report,
        )
        is None
    )
    assert (
        await pg.fetchval(
            "UPDATE service.visits SET status='cancelled' WHERE id=$1 RETURNING id", david_visit
        )
        is None
    )
    await _raises(
        pg,
        "42501",
        "INSERT INTO service.report_revisions(tenant_id,report_id,version,created_by_user_id) "
        "VALUES ($1,$2,2,$3)",
        fixture.tenant.tenant_id,
        david_report,
        fixture.shared_user,
    )
    await _raises(
        pg,
        "42501",
        "INSERT INTO service.technician_session_identities"
        "(tenant_id,auth_session_id,visit_id,technician_id,full_name,employee_identifier,"
        "server_nonce,expires_at) VALUES ($1,$2,$3,$4,'Moshe Fixture','FS-MOSHE',$5,"
        "CURRENT_TIMESTAMP + interval '1 hour')",
        fixture.tenant.tenant_id,
        fixture.session_b,
        david_visit,
        fixture.moshe,
        uuid4().hex,
    )
    await _raises(
        pg,
        "42501",
        "INSERT INTO service.report_attachments"
        "(tenant_id,case_id,visit_id,report_revision_id,object_id,category,source) "
        "VALUES ($1,$2,$3,$4,$5,'fault','technician')",
        fixture.tenant.tenant_id,
        shared_case,
        david_visit,
        david_revision,
        object_id,
    )
    # Moshe works his own visit on the same case normally.
    moshe_report = await pg.fetchval(
        "INSERT INTO service.reports(tenant_id,case_id,visit_id) VALUES ($1,$2,$3) RETURNING id",
        fixture.tenant.tenant_id,
        shared_case,
        moshe_visit,
    )
    await pg.execute(
        "INSERT INTO service.report_revisions(tenant_id,report_id,version,created_by_user_id,"
        "diagnosis) VALUES ($1,$2,1,$3,'Moshe diagnosis')",
        fixture.tenant.tenant_id,
        moshe_report,
        fixture.shared_user,
    )

    # Logging David's device out does not remove his report.
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE platform.auth_sessions SET revoked_at=clock_timestamp(),"
        "revocation_reason='user_logout' WHERE id=$1",
        fixture.session_a,
    )
    await _as(pg, fixture, None, user=fixture.tenant.user_id, role="owner")
    registry = await pg.fetch(
        "SELECT report.tenant_id, revision.diagnosis, technician.full_name "
        "FROM service.report_revisions revision "
        "JOIN service.reports report ON report.id=revision.report_id "
        "JOIN service.visits visit ON visit.id=report.visit_id "
        "JOIN service.technicians technician ON technician.id=visit.technician_id "
        "WHERE report.case_id=$1 ORDER BY technician.full_name",
        shared_case,
    )
    assert [(row["tenant_id"], row["diagnosis"], row["full_name"]) for row in registry] == [
        (fixture.tenant.tenant_id, "David diagnosis", "David Fixture"),
        (fixture.tenant.tenant_id, "Moshe diagnosis", "Moshe Fixture"),
    ]


async def test_shared_sessions_create_and_claim_concurrently(isolated_postgres_url: str) -> None:
    await run_alembic(isolated_postgres_url, "upgrade", "head")
    admin = await asyncpg.connect(isolated_postgres_url)
    try:
        async with admin.transaction():
            fixture = await _shared_technicians(admin, "Concurrent shared sessions")
            await _as(admin, fixture, fixture.session_a)
            await _bind(admin, "David Fixture", "FS-DAVID")
            await _as(admin, fixture, fixture.session_b)
            await _bind(admin, "Moshe Fixture", "FS-MOSHE")
            await admin.execute("RESET ROLE")
            race_case = await _case(admin, fixture, "Contested incident")
            gathered_case = await _case(admin, fixture, "Second contested incident")

        async def connect(session: UUID) -> asyncpg.Connection:
            connection = await asyncpg.connect(isolated_postgres_url)
            await connection.execute("BEGIN")
            await connection.execute("SET LOCAL lock_timeout = '5s'")
            await _as(connection, fixture, session)
            return connection

        create = (
            "SELECT service.create_technician_case($1,NULL,$2,'Synthetic fault',"
            "'unknown',NULL,NULL,NULL,'normal',$3)"
        )

        # Interleaved creation: A's transaction stays open while B commits.
        first = await connect(fixture.session_a)
        second = await connect(fixture.session_b)
        try:
            receipt_a = json.loads(
                await first.fetchval(create, fixture.tenant.contact_id, "Case A", "race-a")
            )
            receipt_b = json.loads(
                await second.fetchval(create, fixture.tenant.contact_id, "Case B", "race-b")
            )
            await second.execute("COMMIT")
            await first.execute("COMMIT")
        finally:
            await first.close()
            await second.close()

        # Two devices registering the same new technician keep one profile.
        async def register(session: UUID) -> str:
            connection = await connect(session)
            try:
                bound = await _bind(connection, "Dana Fixture", "FS-DANA")
                await connection.execute("COMMIT")
                return bound["technicianId"]
            finally:
                await connection.close()

        registrations = await asyncio.gather(
            register(fixture.session_c), register(fixture.session_c)
        )
        assert len(set(registrations)) == 1
        assert (
            await admin.fetchval(
                "SELECT count(*) FROM service.technicians "
                "WHERE tenant_id=$1 AND employee_identifier='FS-DANA'",
                fixture.tenant.tenant_id,
            )
            == 1
        )

        # Simultaneous creation from both sessions.
        async def create_as(session: UUID, title: str) -> dict:
            connection = await connect(session)
            try:
                receipt = json.loads(
                    await connection.fetchval(create, fixture.tenant.contact_id, title, title)
                )
                await connection.execute("COMMIT")
                return receipt
            finally:
                await connection.close()

        parallel = await asyncio.gather(
            create_as(fixture.session_a, "Parallel A"),
            create_as(fixture.session_b, "Parallel B"),
        )
        assert [receipt["technicianId"] for receipt in (receipt_a, receipt_b, *parallel)] == [
            str(fixture.david),
            str(fixture.moshe),
            str(fixture.david),
            str(fixture.moshe),
        ]
        created = await admin.fetch(
            "SELECT title, created_by_user_id, assigned_technician_id FROM service.cases "
            "WHERE title IN ('Case A','Case B','Parallel A','Parallel B') ORDER BY title"
        )
        assert [(row["title"], row["assigned_technician_id"]) for row in created] == [
            ("Case A", fixture.david),
            ("Case B", fixture.moshe),
            ("Parallel A", fixture.david),
            ("Parallel B", fixture.moshe),
        ]
        assert {row["created_by_user_id"] for row in created} == {fixture.shared_user}

        # Deterministic claim race: B waits on A's row lock and then loses.
        first = await connect(fixture.session_a)
        second = await connect(fixture.session_b)
        try:
            won = json.loads(
                await first.fetchval("SELECT service.assign_case($1,NULL,NULL)", race_case)
            )
            losing = asyncio.create_task(
                second.fetchval("SELECT service.assign_case($1,NULL,NULL)", race_case)
            )
            await asyncio.sleep(0.3)
            assert not losing.done()
            await first.execute("COMMIT")
            with pytest.raises(asyncpg.SerializationError):
                await losing
            await second.execute("ROLLBACK")
        finally:
            await first.close()
            await second.close()
        assert won["technicianId"] == str(fixture.david)

        # Unordered claim race: exactly one success, never two active visits.
        async def claim(session: UUID) -> str | None:
            connection = await connect(session)
            try:
                receipt = json.loads(
                    await connection.fetchval(
                        "SELECT service.assign_case($1,NULL,NULL)", gathered_case
                    )
                )
                await connection.execute("COMMIT")
                return receipt["technicianId"]
            except asyncpg.SerializationError:
                await connection.execute("ROLLBACK")
                return None
            finally:
                await connection.close()

        results = await asyncio.gather(claim(fixture.session_a), claim(fixture.session_b))
        assert len([result for result in results if result is not None]) == 1
        for case_id in (race_case, gathered_case):
            visits = await admin.fetch(
                "SELECT technician_id FROM service.visits WHERE case_id=$1 AND status<>'cancelled'",
                case_id,
            )
            assigned = await admin.fetchval(
                "SELECT assigned_technician_id FROM service.cases WHERE id=$1", case_id
            )
            assert [row["technician_id"] for row in visits] == [assigned]
            assert (
                await admin.fetchval(
                    "SELECT count(*) FROM audit.records "
                    "WHERE target_id=$1 AND action='field_service.case.claimed'",
                    case_id,
                )
                == 1
            )
    finally:
        await admin.close()
