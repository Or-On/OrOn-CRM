import uuid

from asyncpg.exceptions import UniqueViolationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from oron_tenancy.models import (
    ApiKey,
    IdentityBinding,
    Membership,
    MembershipPublic,
    PhoneNumber,
    Role,
    Tenant,
    TenantCreate,
    User,
    UserPrincipal,
    UserStatus,
)


class EmailAlreadyInvited(Exception):
    """The unique index fired. Check-then-insert is a race, so this is the real
    guard and the handler's job is only to translate it."""


class WouldLockOut(Exception):
    """The change would leave a tenant with no owner, or the system with no
    active superuser. Refused rather than discovered during a customer's first
    week."""


class IdentityAlreadyBound(Exception):
    """An external provider subject already belongs to a canonical user.

    Never resolved by rebinding: that hands an account to whoever signed in
    most recently. Recovery is an explicit unbind by an owner.
    """


async def create_tenant(*, session: AsyncSession, tenant_in: TenantCreate) -> Tenant:
    obj = Tenant(**tenant_in.model_dump())
    session.add(obj)
    await session.flush()
    await session.refresh(obj)
    return obj


async def get_api_key_by_hash(*, session: AsyncSession, hashed: str) -> ApiKey | None:
    result = await session.execute(
        select(ApiKey).where(col(ApiKey.hashed_key) == hashed, col(ApiKey.status) == "active")
    )
    return result.scalar_one_or_none()


async def no_api_keys_yet(*, session: AsyncSession) -> bool:
    """Whether this deployment has ever been issued a key.

    Deliberately not "and no tenants either", which would be the stronger
    question: `0002` seeds a Default tenant, so a freshly migrated database has
    one before anybody has done anything, and no deployment would ever qualify.
    """
    return (await session.execute(select(col(ApiKey.id)).limit(1))).first() is None


async def get_tenant(*, session: AsyncSession, tenant_id: uuid.UUID) -> Tenant | None:
    return await session.get(Tenant, tenant_id)


async def get_phone_number(*, session: AsyncSession, e164: str) -> PhoneNumber | None:
    result = await session.execute(select(PhoneNumber).where(col(PhoneNumber.e164) == e164))
    return result.scalar_one_or_none()


async def create_user(*, session: AsyncSession, email: str, is_superuser: bool = False) -> User:
    """Insert and let the unique index decide.

    Not "look it up, then insert" — two invites for one address both pass that
    check and the second dies on the index as a 500. Only a unique violation is
    a duplicate; any other integrity failure is a different problem and must not
    be reported as "already invited".
    """
    obj = User(email=email, is_superuser=is_superuser)
    session.add(obj)
    try:
        await session.flush()
    except IntegrityError as exc:
        orig = exc.orig
        if orig is None or not isinstance(orig.__cause__, UniqueViolationError):
            raise
        raise EmailAlreadyInvited(email) from exc
    await session.refresh(obj)
    return obj


async def _owner_count(*, session: AsyncSession, tenant_id: uuid.UUID) -> int:
    """Count the owners *and hold them* until this transaction ends.

    A bare COUNT is not a guard. Under READ COMMITTED two concurrent removals
    both read two owners, both pass, and both commit — leaving the tenant with
    none, which is the one thing this exists to prevent. FOR UPDATE makes the
    second caller wait, and Postgres re-checks the predicate when it wakes, so
    the row the first one deleted or re-graded is gone from the second's count.

    Rows rather than COUNT(*): FOR UPDATE cannot be combined with an aggregate.
    ORDER BY so two callers take the locks in the same order.
    """
    rows = await session.execute(
        select(col(Membership.user_id))
        .where(col(Membership.tenant_id) == tenant_id, col(Membership.role) == Role.OWNER)
        .order_by(col(Membership.user_id))
        .with_for_update()
    )
    return len(rows.all())


async def _active_superuser_count(*, session: AsyncSession) -> int:
    """Locked for the reason `_owner_count` is, against the same race."""
    rows = await session.execute(
        select(col(User.id))
        .where(col(User.is_superuser).is_(True), col(User.status) == UserStatus.ACTIVE)
        .order_by(col(User.id))
        .with_for_update()
    )
    return len(rows.all())


async def set_user_status(
    *, session: AsyncSession, user_id: uuid.UUID, status: UserStatus
) -> User | None:
    """None when there is no such user. Refuses to disable the last active
    superuser — there is no second one by default, and the only way back would be
    a direct POST with the service key."""
    user = await session.get(User, user_id)
    if user is None:
        return None
    if (
        user.is_superuser
        and status is UserStatus.DISABLED
        and await _active_superuser_count(session=session) <= 1
    ):
        raise WouldLockOut("cannot disable the last active superuser")
    user.status = status
    await session.flush()
    return user


async def _principal(*, session: AsyncSession, user: User | None) -> UserPrincipal | None:
    """The memberships half, shared by both lookups so they cannot answer
    differently for the same person."""
    if user is None:
        return None
    rows = (
        await session.execute(
            select(Membership, Tenant)
            .join(Tenant, col(Tenant.id) == col(Membership.tenant_id))
            .where(col(Membership.user_id) == user.id)
        )
    ).all()
    return UserPrincipal(
        id=user.id,
        email=user.email,
        is_superuser=user.is_superuser,
        status=user.status,
        memberships=[
            MembershipPublic(tenant_id=m.tenant_id, tenant_name=t.name, role=m.role)
            for m, t in rows
        ],
    )


async def get_principal_by_email(*, session: AsyncSession, email: str) -> UserPrincipal | None:
    """Resolve by the invite key. Case-insensitive because `email` is citext."""
    user = (
        await session.execute(select(User).where(col(User.email) == email))
    ).scalar_one_or_none()
    return await _principal(session=session, user=user)


async def get_principal_by_identity(
    *, session: AsyncSession, provider: str, provider_subject: str
) -> UserPrincipal | None:
    """Resolve through a provider-neutral canonical identity binding."""
    user = (
        await session.execute(
            select(User)
            .join(IdentityBinding, col(IdentityBinding.user_id) == col(User.id))
            .where(
                col(IdentityBinding.provider) == provider,
                col(IdentityBinding.provider_subject) == provider_subject,
            )
        )
    ).scalar_one_or_none()
    return await _principal(session=session, user=user)


async def bind_identity(
    *,
    session: AsyncSession,
    user_id: uuid.UUID,
    provider: str,
    provider_subject: str,
    provider_email: str | None = None,
) -> IdentityBinding:
    """Attach an external identity to a user, once and only once.

    Deliberately not idempotent: a repeat means the caller believed this account
    was unbound when it was not, and swallowing that hides the disagreement.
    """
    if await session.get(User, user_id) is None:
        raise IdentityAlreadyBound(f"no user {user_id}")

    existing = (
        await session.execute(
            select(IdentityBinding).where(
                col(IdentityBinding.provider) == provider,
                col(IdentityBinding.provider_subject) == provider_subject,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise IdentityAlreadyBound(f"{provider}:{provider_subject} is already bound to a user")

    obj = IdentityBinding(
        user_id=user_id,
        provider=provider,
        provider_subject=provider_subject,
        provider_email=provider_email,
    )
    session.add(obj)
    await session.flush()
    return obj


async def set_membership(
    *, session: AsyncSession, user_id: uuid.UUID, tenant_id: uuid.UUID, role: Role
) -> Membership:
    """Create or re-grade. Idempotent on the pair, so re-inviting someone at a
    different role is one call rather than a delete and an insert."""
    existing = await session.get(Membership, (user_id, tenant_id))
    if existing is not None:
        await _refuse_if_last_owner(session=session, existing=existing, becoming=role)
        existing.role = role
        await session.flush()
        return existing
    obj = Membership(user_id=user_id, tenant_id=tenant_id, role=role)
    session.add(obj)
    await session.flush()
    return obj


async def remove_membership(
    *, session: AsyncSession, user_id: uuid.UUID, tenant_id: uuid.UUID
) -> bool:
    existing = await session.get(Membership, (user_id, tenant_id))
    if existing is None:
        return False
    await _refuse_if_last_owner(session=session, existing=existing, becoming=None)
    await session.delete(existing)
    await session.flush()
    return True


async def _refuse_if_last_owner(
    *, session: AsyncSession, existing: Membership, becoming: Role | None
) -> None:
    """One guard, both callers.

    `becoming=None` is a removal. Re-grading an owner down strips the tenant of
    its last owner exactly as effectively as deleting the row, so guarding only
    the delete path would leave that door open.
    """
    if existing.role is not Role.OWNER or becoming is Role.OWNER:
        return
    if await _owner_count(session=session, tenant_id=existing.tenant_id) <= 1:
        raise WouldLockOut(f"tenant {existing.tenant_id} would be left without an owner")
