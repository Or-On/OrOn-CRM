import hashlib
import secrets
import uuid
from http import HTTPMethod

from fastapi import Header, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from oron_tenancy import crud
from oron_tenancy.models import ApiKeyKind

_KEY_PREFIX = "oron_"

BOOTSTRAP_LOCK = 8_240_119
"""Advisory lock id serialising first-run key creation. Arbitrary but fixed —
two callers must choose the same number to queue behind each other."""


def hash_key(plaintext: str) -> str:
    # API keys are high-entropy random tokens → sha256 is sufficient (no salt/stretch needed).
    return hashlib.sha256(plaintext.encode()).hexdigest()


def generate_api_key() -> tuple[str, str]:
    plaintext = _KEY_PREFIX + secrets.token_urlsafe(32)
    return plaintext, hash_key(plaintext)


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    return authorization.removeprefix("Bearer ").strip()


async def resolve_tenant(
    *, session: AsyncSession, authorization: str | None, x_tenant_id: str | None
) -> uuid.UUID:
    token = _bearer(authorization)
    key = await crud.get_api_key_by_hash(session=session, hashed=hash_key(token))
    if key is None:
        raise HTTPException(status_code=401, detail="invalid api key")
    if key.kind == ApiKeyKind.SERVICE:
        if not x_tenant_id:
            raise HTTPException(status_code=400, detail="service key requires X-Tenant-Id")
        # A header, so it is whatever the caller sent — a bad one is a 400, not
        # the 500 an escaping ValueError would produce.
        try:
            return uuid.UUID(x_tenant_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="X-Tenant-Id is not a valid tenant id")
    if key.tenant_id is None:
        raise HTTPException(status_code=401, detail="tenant key without tenant")
    return key.tenant_id


async def _is_bootstrap(request: Request, *, session: AsyncSession) -> bool:
    """`POST /api_keys` on a deployment that has no keys at all.

        `api_keys` stores only a hash, so a key nobody issued matches no row — which
        makes this route the only way any key can come into existence, including the
        first. Requiring one to mint it is a locked door with the key inside.

        The exemption closes behind itself: one key exists after this succeeds, and
        every later request takes the guarded path.

    Deleting the last key does not reopen it on its own — the condition is that
        nothing exists at all, tenants included, so a deployment with customers stays
        shut whatever happened to its key table.

        This answer is advisory. It is read in this dependency's own transaction and
        the insert happens in the route's, so `create_api_key` takes the lock and
        asks again before writing. Without that, two concurrent first-run requests
        both read an empty table and both mint.
    """
    if request.method != HTTPMethod.POST or request.url.path.rstrip("/") != "/api_keys":
        return False
    return await crud.no_api_keys_yet(session=session)


async def require_service_key(
    request: Request,
    authorization: str | None = Header(default=None),
) -> None:
    """The control plane's gate: a service key, and nothing else.

    These routes name every customer, create accounts and mint credentials. They
    are not tenant-scoped — they *define* the tenants scoping is based on — so a
    tenant key must not reach them, or one customer's key is a key to all of it.

    Attached to the router rather than route by route: a guard is only as good as
    its least-guarded endpoint, and the next route added inherits this one.
    """
    sm = request.app.state.control_sessionmaker
    async with sm() as s:
        if await _is_bootstrap(request, session=s):
            # The route re-checks under a lock; this only spares the common case
            # a wasted round trip.
            request.state.bootstrapping = True
            return
        key = await crud.get_api_key_by_hash(session=s, hashed=hash_key(_bearer(authorization)))
    if key is None:
        raise HTTPException(status_code=401, detail="invalid api key")
    if key.kind != ApiKeyKind.SERVICE:
        raise HTTPException(status_code=403, detail="the control plane requires a service key")


async def require_tenant(
    request: Request,
    authorization: str | None = Header(default=None),
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> uuid.UUID:
    """FastAPI dependency: resolve the tenant using a control-plane (untenanted)
    session to look up the API key — `api_keys` is granted to the tenancy role
    only, so the session-side sessionmaker cannot read it."""
    sm = request.app.state.control_sessionmaker
    async with sm() as s:
        return await resolve_tenant(session=s, authorization=authorization, x_tenant_id=x_tenant_id)
