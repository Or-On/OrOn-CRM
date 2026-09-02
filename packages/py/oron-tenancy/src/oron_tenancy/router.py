import uuid
from collections.abc import AsyncIterator
from http import HTTPMethod

from asyncpg.exceptions import UniqueViolationError
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from loguru import logger
from oron_flows import FlowStore
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from oron_tenancy import crud
from oron_tenancy.admission import repoint
from oron_tenancy.crud import EmailAlreadyInvited, IdentityAlreadyBound, WouldLockOut
from oron_tenancy.flow_store import FlowNotFound
from oron_tenancy.models import (
    ApiKey,
    ApiKeyKind,
    ApiKeyPublic,
    Membership,
    PhoneNumber,
    PhoneNumberCreate,
    PhoneNumberPublic,
    Role,
    Tenant,
    TenantCreate,
    TenantPublic,
    User,
    UserPrincipal,
    UserStatus,
)
from oron_tenancy.provisioner import SipProvisioner
from oron_tenancy.reconcile import (
    Finding,
    ReconciliationReport,
    RegisteredNumber,
    reconcile,
)
from oron_tenancy.security import BOOTSTRAP_LOCK, generate_api_key, require_service_key

# Administrative/internal. These endpoints are deliberately NOT tenant-scoped —
# they define the tenants that scoping is based on, so they run on an untenanted
# session and must be reachable only by operators and the dispatcher.
#
# The dependency is on the router, not on each route: until it was added these
# were guarded by nothing but not being published through Caddy, and one route
# added without a guard is the whole control plane. See `require_service_key`
# for the single bootstrap carve-out.
router = APIRouter(tags=["control-plane"], dependencies=[Depends(require_service_key)])


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    """An untenanted session on the tenancy DB role — the one granted the
    control-plane tables and nothing else."""
    sessionmaker = request.app.state.control_sessionmaker
    async with sessionmaker() as db, db.begin():
        yield db


def get_flow_store(request: Request) -> FlowStore:
    """The flow store, injected on app.state by the lifespan."""
    return request.app.state.flow_store


def get_sip_provisioner(request: Request) -> SipProvisioner:
    """The SIP provisioner, injected on app.state. Absent (dev without a SIP
    stack) means registration fails closed — we won't persist a number LiveKit
    would never route."""
    provisioner = getattr(request.app.state, "sip_provisioner", None)
    if provisioner is None:
        raise HTTPException(status_code=503, detail="SIP provisioning unavailable")
    return provisioner


class ResolvePhoneResponse(BaseModel):
    tenant_id: uuid.UUID
    flow_id: uuid.UUID


class PhoneNumberUpdate(BaseModel):
    flow_id: uuid.UUID


class ApiKeyCreate(BaseModel):
    tenant_id: uuid.UUID | None = None
    kind: ApiKeyKind = ApiKeyKind.TENANT


class ApiKeyCreated(ApiKeyPublic):
    # The plaintext key — returned once, never stored (only its hash is).
    api_key: str


@router.get("/tenants", response_model=list[TenantPublic])
async def list_tenants(db: AsyncSession = Depends(get_db)) -> list[Tenant]:
    """Every tenant, for the superuser's switcher. Names, ids and status only —
    the switcher is the one cross-tenant surface in the product, and it must not
    become the place two tenants' data meet."""
    return list((await db.execute(select(Tenant))).scalars().all())


# Declared before any /users/{...} route: FastAPI matches in declaration order, so
# a literal placed after a path parameter is unreachable.
@router.get("/users/by-email", response_model=UserPrincipal)
async def user_by_email(
    email: str = Query(...), db: AsyncSession = Depends(get_db)
) -> UserPrincipal:
    """Resolve a verified address to what it may reach. The 404 is the invite gate.

    A query parameter rather than a path segment: `+` is a legal, common part of
    an address and some proxies decode it as a space in a path — a failure that
    would surface as "not invited" and be debugged for an afternoon.
    """
    principal = await crud.get_principal_by_email(session=db, email=email)
    if principal is None:
        raise HTTPException(status_code=404, detail="unknown user")
    return principal


# Also declared before /users/{user_id}, for the same reason as /users/by-email.
@router.get("/users/by-identity", response_model=UserPrincipal)
async def user_by_identity(
    provider: str = Query(...),
    subject: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> UserPrincipal:
    """Resolve through the canonical provider-neutral identity binding."""
    principal = await crud.get_principal_by_identity(
        session=db, provider=provider, provider_subject=subject
    )
    if principal is None:
        raise HTTPException(status_code=404, detail="no user bound to that account")
    return principal


class IdentityBind(BaseModel):
    provider: str
    provider_subject: str
    provider_email: str | None = None


class UserCreate(BaseModel):
    email: str
    is_superuser: bool = False


class MembershipGrant(BaseModel):
    role: Role


class UserStatusUpdate(BaseModel):
    status: UserStatus


class TenantMember(BaseModel):
    user_id: uuid.UUID
    email: str
    role: Role
    status: UserStatus


# These carry no authorisation of their own. The whole control plane is reachable
# only with a service key, and PR 3's BFF is what checks the caller is an owner.
@router.post("/users", response_model=UserPrincipal, status_code=201)
async def invite_user(data: UserCreate, db: AsyncSession = Depends(get_db)) -> UserPrincipal:
    """Add the canonical user row that forms the invitation gate."""
    try:
        user = await crud.create_user(session=db, email=data.email, is_superuser=data.is_superuser)
    except EmailAlreadyInvited:
        raise HTTPException(status_code=409, detail="user already exists")
    return UserPrincipal(
        id=user.id,
        email=user.email,
        is_superuser=user.is_superuser,
        status=user.status,
        memberships=[],
    )


@router.post("/users/{user_id}/identity", status_code=201)
async def bind_identity(
    user_id: uuid.UUID, data: IdentityBind, db: AsyncSession = Depends(get_db)
) -> dict:
    """Attach an external identity on first sign-in. Bind-once: every refusal is a
    409, because a rebind hands an account to whoever signed in most recently."""
    try:
        await crud.bind_identity(
            session=db,
            user_id=user_id,
            provider=data.provider,
            provider_subject=data.provider_subject,
            provider_email=data.provider_email,
        )
    except IdentityAlreadyBound as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {
        "user_id": str(user_id),
        "provider": data.provider,
        "provider_subject": data.provider_subject,
    }


@router.patch("/users/{user_id}", response_model=UserPrincipal)
async def set_user_status(
    user_id: uuid.UUID, data: UserStatusUpdate, db: AsyncSession = Depends(get_db)
) -> UserPrincipal:
    try:
        user = await crud.set_user_status(session=db, user_id=user_id, status=data.status)
    except WouldLockOut as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if user is None:
        raise HTTPException(status_code=404, detail="unknown user")
    principal = await crud.get_principal_by_email(session=db, email=user.email)
    assert principal is not None  # just written in this transaction
    return principal


@router.put("/users/{user_id}/memberships/{tenant_id}")
async def grant_membership(
    user_id: uuid.UUID,
    tenant_id: uuid.UUID,
    data: MembershipGrant,
    db: AsyncSession = Depends(get_db),
) -> dict:
    if await db.get(User, user_id) is None:
        raise HTTPException(status_code=404, detail="unknown user")
    if await db.get(Tenant, tenant_id) is None:
        raise HTTPException(status_code=404, detail="unknown tenant")
    try:
        await crud.set_membership(session=db, user_id=user_id, tenant_id=tenant_id, role=data.role)
    except WouldLockOut as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"user_id": str(user_id), "tenant_id": str(tenant_id), "role": data.role}


@router.delete("/users/{user_id}/memberships/{tenant_id}", status_code=204)
async def revoke_membership(
    user_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> Response:
    try:
        removed = await crud.remove_membership(session=db, user_id=user_id, tenant_id=tenant_id)
    except WouldLockOut as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if not removed:
        raise HTTPException(status_code=404, detail="unknown membership")
    return Response(status_code=204)


@router.get("/tenants/{tenant_id}/members", response_model=list[TenantMember])
async def list_members(
    tenant_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> list[TenantMember]:
    rows = (
        await db.execute(
            select(Membership, User)
            .join(User, col(User.id) == col(Membership.user_id))
            .where(col(Membership.tenant_id) == tenant_id)
        )
    ).all()
    return [
        TenantMember(user_id=u.id, email=u.email, role=m.role, status=u.status) for m, u in rows
    ]


@router.post("/tenants", response_model=TenantPublic, status_code=201)
async def create_tenant(data: TenantCreate, db: AsyncSession = Depends(get_db)) -> Tenant:
    return await crud.create_tenant(session=db, tenant_in=data)


CONFLICT = "phone number already registered"


async def _require_known_flow(store: FlowStore, tenant_id: uuid.UUID, flow_id: uuid.UUID) -> None:
    """A DID bound to a flow nobody has published answers with a substitute, and
    the operator who typo'd it finds out from a customer. Refuse at the bind.

    Asked of the store rather than the packaged catalog, so a tenant can bind a
    flow it published itself — and so a packaged flow that never converged is
    caught here rather than on someone's answer path.
    """
    try:
        await store.load_latest(str(tenant_id), flow_id)
    except FlowNotFound:
        raise HTTPException(status_code=422, detail=f"unknown flow {flow_id}")


async def _diagnose(existing: PhoneNumber, provisioner: SipProvisioner) -> Finding | None:
    """Whether the DID's own rule is actually admitting it; None if it is healthy.

    Raises if LiveKit cannot be reached — "we could not look" is not the same
    answer as "it is fine", and the two callers want to treat it differently.

    Only the DID in hand is checked. Drift nobody is currently asking about — a
    stray rule, or a catch-all belonging to no DID — has no request to hang off,
    and is what `GET /phone_numbers/reconcile` sweeps for.
    """
    rules = await provisioner.list_dispatch_rules(ids=[existing.dispatch_rule_id])
    report = reconcile(
        rules=rules,
        registered=[
            RegisteredNumber(e164=existing.e164, dispatch_rule_id=existing.dispatch_rule_id)
        ],
    )
    return report.findings[0] if report.findings else None


async def _describe_conflict(existing: PhoneNumber, provisioner: SipProvisioner) -> str:
    """Explain a duplicate registration, naming a broken rule if that is why the
    operator is here. Best-effort: registration already has its answer, so an
    unreachable LiveKit degrades to the plain conflict rather than failing."""
    try:
        finding = await _diagnose(existing, provisioner)
    except Exception as exc:
        logger.warning(f"could not check SIP dispatch rule ({type(exc).__name__})")
        return CONFLICT
    if finding is None:
        return CONFLICT

    logger.error(
        f"registered SIP endpoint is not admissible: issue={finding.issue} "
        f"rule={finding.dispatch_rule_id or 'none'}"
    )
    # Ask the router where repair lives rather than restating the path: a renamed
    # route must not leave this message pointing at one that no longer exists.
    repair = router.url_path_for("reprovision_phone_number", e164=existing.e164)
    return (
        f"{CONFLICT}, but its dispatch rule is unhealthy: {finding.detail}. "
        f"{HTTPMethod.POST} {repair} to repair it."
    )


async def _repair(
    existing: PhoneNumber, finding: Finding, provisioner: SipProvisioner, db: AsyncSession
) -> None:
    """Give a registered DID a working rule again, translating a failure to 502.

    The repair itself is `admission.repoint`, shared with startup convergence so
    "repair" means one thing here and on boot.
    """
    logger.error(
        f"repairing SIP admission: issue={finding.issue} rule={finding.dispatch_rule_id or 'none'}"
    )
    try:
        await repoint(existing, provisioner, db)
    except Exception as exc:
        logger.error(f"could not re-provision SIP admission ({type(exc).__name__})")
        raise HTTPException(status_code=502, detail="failed to re-provision SIP admission")


@router.post("/phone_numbers", response_model=PhoneNumberPublic, status_code=201)
async def create_phone_number(
    data: PhoneNumberCreate,
    db: AsyncSession = Depends(get_db),
    provisioner: SipProvisioner = Depends(get_sip_provisioner),
    store: FlowStore = Depends(get_flow_store),
) -> PhoneNumber:
    """Register a DID for a tenant and provision its SIP admission.

    Order matters: reject a duplicate DID or an unknown tenant before asking
    LiveKit for a rule, so a rejection never leaves an orphaned rule behind;
    provision; then persist the number with its rule id. If provisioning fails the
    row is never written, and if the insert loses a race the rule is torn back
    down — a persisted number always has exactly one live rule.

    A duplicate is refused, never silently repaired: this endpoint creates or it
    declines, and does not mutate LiveKit for a number that already exists. When
    the existing DID's rule is broken — often exactly why someone is re-registering
    it — the 409 says so and points at `/phone_numbers/{e164}/reprovision`.
    """
    await _require_known_flow(store, data.tenant_id, data.flow_id)
    existing = await crud.get_phone_number(session=db, e164=data.e164)
    if existing is not None:
        raise HTTPException(status_code=409, detail=await _describe_conflict(existing, provisioner))

    if await db.get(Tenant, data.tenant_id) is None:
        raise HTTPException(status_code=404, detail="unknown tenant")

    try:
        dispatch_rule_id = await provisioner.provision_did(data.e164)
    except Exception as exc:
        logger.error(f"SIP provisioning failed ({type(exc).__name__})")
        raise HTTPException(status_code=502, detail="failed to provision SIP admission")

    obj = PhoneNumber(**data.model_dump(), dispatch_rule_id=dispatch_rule_id)
    db.add(obj)
    try:
        await db.flush()
    except IntegrityError as integrity_exc:
        # The row was not persisted, so the rule we just created has nothing to
        # admit calls for — tear it down whatever the cause was.
        try:
            await provisioner.deprovision_did(dispatch_rule_id)
        except Exception as exc:
            # The rollback itself failed, so the rule outlives the request. That
            # is an ops problem (a stray rule pointing at a DID owned by whoever
            # won the race), not the client's — surface it loudly for cleanup but
            # still answer the truthful error rather than masking it with a 500.
            logger.error(
                f"ORPHANED SIP dispatch rule {dispatch_rule_id}: registration failed "
                f"and deprovisioning failed too ({type(exc).__name__}). "
                "Manual cleanup required."
            )
        # Only a unique violation means we lost the DID race. Any other integrity
        # failure (e.g. the tenant deleted since the pre-check) is a different
        # problem, and answering it with "already registered" would send the
        # operator hunting for a number that is in fact still free.
        orig = integrity_exc.orig
        if orig is None or not isinstance(orig.__cause__, UniqueViolationError):
            raise
        raise HTTPException(status_code=409, detail=CONFLICT)
    await db.refresh(obj)
    return obj


@router.get("/phone_numbers/reconcile", response_model=ReconciliationReport)
async def reconcile_sip_admission(
    db: AsyncSession = Depends(get_db),
    provisioner: SipProvisioner = Depends(get_sip_provisioner),
) -> ReconciliationReport:
    """Diff every dispatch rule on the server against every registered number.

    The per-DID check on registration and repair can only see drift for a number
    someone is asking about by name. Two kinds have no such request to hang off:
    a rule nobody claims, and a catch-all belonging to no number at all — the one
    that quietly turns admission control off for every DID while it exists.

    Read-only, and always 200 with a report: `ok` says whether anything was found,
    so this can be polled. Deleting a rule stays deliberate — one that looks stray
    from the database's side may be the only thing admitting a live number.
    """
    try:
        rules = await provisioner.list_dispatch_rules()
    except Exception as exc:
        logger.error(f"could not list SIP dispatch rules ({type(exc).__name__})")
        raise HTTPException(status_code=502, detail="failed to list SIP dispatch rules")

    rows = (await db.execute(select(PhoneNumber))).scalars().all()
    report = reconcile(
        rules=rules,
        registered=[
            RegisteredNumber(e164=r.e164, dispatch_rule_id=r.dispatch_rule_id) for r in rows
        ],
    )
    if not report.ok:
        logger.warning(f"SIP admission has drifted: {len(report.findings)} finding(s)")
    return report


@router.post("/phone_numbers/{e164}/reprovision", response_model=PhoneNumberPublic)
async def reprovision_phone_number(
    e164: str,
    db: AsyncSession = Depends(get_db),
    provisioner: SipProvisioner = Depends(get_sip_provisioner),
) -> PhoneNumber:
    """Make a registered DID admissible again.

    The repair for a row that outlived its LiveKit rule: check the rule the row
    claims, and if it is gone or no longer admits this number, provision a fresh
    one and repoint the row. Idempotent — a healthy DID is returned untouched
    rather than churning out a second rule.

    Unlike registration this is an explicit request to check, so an unreachable
    LiveKit is a 502: we cannot tell whether a rule exists, and provisioning
    blindly would create a duplicate whenever the answer was "it is fine".
    """
    row = await crud.get_phone_number(session=db, e164=e164)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown phone number")

    try:
        finding = await _diagnose(row, provisioner)
    except Exception as exc:
        logger.error(f"could not check SIP admission ({type(exc).__name__})")
        raise HTTPException(status_code=502, detail="failed to check SIP admission")

    if finding is None:
        logger.info(f"SIP rule {row.dispatch_rule_id} is already admissible; nothing to do")
        return row

    await _repair(row, finding, provisioner, db)
    return row


@router.patch("/phone_numbers/{e164}", response_model=PhoneNumberPublic)
async def update_phone_number(
    e164: str,
    data: PhoneNumberUpdate,
    db: AsyncSession = Depends(get_db),
    store: FlowStore = Depends(get_flow_store),
) -> PhoneNumber:
    """Point a registered DID at a different flow.

    Only `flow_id` is mutable: the number and its tenant define the row, and its
    dispatch rule is repaired through `/reprovision`, never edited here.
    """
    row = await crud.get_phone_number(session=db, e164=e164)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown phone number")
    # After the lookup, not before: which flows are legal depends on whose DID
    # this is, and only the row says that.
    await _require_known_flow(store, row.tenant_id, data.flow_id)
    previous, row.flow_id = row.flow_id, data.flow_id
    await db.flush()
    logger.info(f"phone-number record {row.id} now uses flow {row.flow_id} (was {previous})")
    return row


@router.get("/resolve/phone/{e164}", response_model=ResolvePhoneResponse)
async def resolve_phone(e164: str, db: AsyncSession = Depends(get_db)) -> ResolvePhoneResponse:
    row = await crud.get_phone_number(session=db, e164=e164)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown phone number")
    return ResolvePhoneResponse(tenant_id=row.tenant_id, flow_id=row.flow_id)


@router.post("/api_keys", response_model=ApiKeyCreated, status_code=201)
async def create_api_key(
    request: Request, data: ApiKeyCreate, db: AsyncSession = Depends(get_db)
) -> ApiKeyCreated:
    if getattr(request.state, "bootstrapping", False):
        # The guard read "nothing exists here" in its own transaction and this
        # one does the writing, so the two are not a single decision. Take the
        # lock, then ask again where the insert can see the answer — otherwise
        # two concurrent first-run requests both pass and both mint, leaving a
        # live service key nobody recorded.
        await db.execute(select(func.pg_advisory_xact_lock(BOOTSTRAP_LOCK)))
        if not await crud.no_api_keys_yet(session=db):
            raise HTTPException(status_code=401, detail="invalid api key")

    plaintext, hashed = generate_api_key()
    obj = ApiKey(hashed_key=hashed, tenant_id=data.tenant_id, kind=data.kind)
    db.add(obj)
    await db.flush()
    await db.refresh(obj)
    return ApiKeyCreated(
        id=obj.id, tenant_id=obj.tenant_id, kind=obj.kind, status=obj.status, api_key=plaintext
    )
