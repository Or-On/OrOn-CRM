import datetime as dt
import uuid
from enum import StrEnum

import sqlalchemy as sa
from oron_common import E164
from oron_db import Timestamped
from pydantic import BaseModel
from sqlalchemy import DateTime, func
from sqlalchemy.dialects.postgresql import CITEXT, JSONB
from sqlmodel import Field, SQLModel


class TenantBase(SQLModel):
    name: str
    slug: str = Field(index=True)


class TenantCreate(TenantBase):
    pass


class Tenant(TenantBase, Timestamped, table=True):
    __tablename__ = "tenants"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    status: str = "active"


class TenantPublic(TenantBase):
    id: uuid.UUID
    status: str


class PhoneNumberBase(SQLModel):
    # Validated + normalised to E.164 on the way in; a malformed number is a 422
    # before we ever ask LiveKit to provision a rule for it.
    e164: E164 = Field(index=True, unique=True)
    tenant_id: uuid.UUID = Field(foreign_key="tenants.id", index=True)
    # No FK even though `flows` lives in this database: a DID binds a flow_id and
    # never a version, while flows is keyed (flow_id, version) — there is no
    # single row to point at. Existence is checked at the bind instead.
    flow_id: uuid.UUID


class PhoneNumberCreate(PhoneNumberBase):
    pass


class PhoneNumber(PhoneNumberBase, Timestamped, table=True):
    __tablename__ = "phone_numbers"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    # The LiveKit dispatch rule that admits this DID's calls. Server-set at
    # registration and required: a persisted number is always one LiveKit will
    # route, never a half-registered row that silently accepts nothing.
    dispatch_rule_id: str


class PhoneNumberPublic(PhoneNumberBase):
    id: uuid.UUID
    dispatch_rule_id: str


class Flow(Timestamped, table=True):
    """One published version of one flow.

    Both the authored `source` and the expanded `spec` are stored: the spec is
    what a call runs (frozen against the component library that built it), and
    the source is what an editor reopens. Re-expanding the source on load would
    throw away exactly the freeze guarantee the store exists to provide.
    """

    __tablename__ = "flows"
    # Composite key: a flow keeps its id across versions, and a published version
    # is immutable — republishing means inserting the next one.
    flow_id: uuid.UUID = Field(primary_key=True)
    version: int = Field(primary_key=True)
    # NULL means the packaged catalog this build ships: owned by no tenant and
    # runnable by all. RLS lets every tenant read those and write only its own.
    tenant_id: uuid.UUID | None = Field(default=None, foreign_key="tenants.id", index=True)
    # pyrefly: ignore[no-matching-overload]  # sa_type is only on the
    # sa_column-less overload, which sqlmodel's stubs do not expose.
    source: dict = Field(sa_type=JSONB, nullable=False)
    # pyrefly: ignore[no-matching-overload]  # see source above.
    spec: dict = Field(sa_type=JSONB, nullable=False)
    # The component-library version that expanded source -> spec.
    components_version: str


class ApiKeyKind(StrEnum):
    """What a key may reach. The column stays VARCHAR — comparing a StrEnum to it
    works either way, and changing the type would be a migration for no gain."""

    TENANT = "tenant"
    SERVICE = "service"


class ApiKey(Timestamped, table=True):
    __tablename__ = "api_keys"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    hashed_key: str = Field(index=True, unique=True)
    tenant_id: uuid.UUID | None = Field(default=None, foreign_key="tenants.id", index=True)
    kind: str = ApiKeyKind.TENANT
    status: str = "active"
    name: str = Field(default="Legacy key", sa_type=sa.Text)
    prefix: str = Field(default="legacy", sa_type=sa.Text)
    # pyrefly: ignore[no-matching-overload]  # SQLModel stubs omit constructed SQL types.
    scopes: list[str] = Field(
        default_factory=lambda: ["crm:read"],
        sa_type=sa.ARRAY(sa.Text),
    )
    created_by_user_id: uuid.UUID | None = Field(
        default=None, foreign_key="users.id", ondelete="SET NULL"
    )
    # pyrefly: ignore[no-matching-overload]  # see scopes above.
    last_used_at: dt.datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
    # pyrefly: ignore[no-matching-overload]  # see scopes above.
    expires_at: dt.datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
    # pyrefly: ignore[no-matching-overload]  # see scopes above.
    revoked_at: dt.datetime | None = Field(default=None, sa_type=DateTime(timezone=True))


class ApiKeyPublic(SQLModel):
    id: uuid.UUID
    tenant_id: uuid.UUID | None
    kind: str
    status: str


def _enum(cls: type[StrEnum]) -> sa.Enum:
    """VARCHAR in the database, the enum in Python.

    `native_enum=False` keeps a new value from needing ALTER TYPE. But a plain
    `sa.String` is not enough: it round-trips as `str`, so `role is Role.OWNER`
    is quietly False and `role.at_least(...)` raises AttributeError — on a value
    loaded from the database, which is every value that matters.
    """
    return sa.Enum(
        cls,
        native_enum=False,
        create_constraint=False,
        length=16,
        # Persist "active", not the member name "ACTIVE" that sa.Enum defaults to.
        # The migration's server_default, the JSON the API serves and the console
        # all say "active", so a name here turns a row written by that default
        # into a LookupError on load. Same call oron_sessions makes.
        values_callable=lambda e: [m.value for m in e],
    )


class Role(StrEnum):
    """Declaration order is the rank. Compare with `at_least`, never with `>=` —
    lexical string order is not authorization."""

    VIEWER = "viewer"
    AGENT = "agent"
    ADMIN = "admin"
    OWNER = "owner"

    def at_least(self, floor: Role) -> bool:
        order = list(Role)
        return order.index(self) >= order.index(floor)


class UserStatus(StrEnum):
    ACTIVE = "active"
    DISABLED = "disabled"


class User(Timestamped, table=True):
    """A canonical person who may sign in and receive tenant memberships."""

    __tablename__ = "users"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    # citext, not a lowercasing validator: the guarantee has to hold whatever
    # path writes the row, so `Noa@` and `noa@` cannot become two accounts.
    # pyrefly: ignore[no-matching-overload]  # sa_type is only on the
    # sa_column-less overload, which sqlmodel's stubs do not expose.
    email: str = Field(sa_type=CITEXT, unique=True, index=True)
    # Selects which tenants may be chosen, never what may be done inside one.
    is_superuser: bool = False
    # pyrefly: ignore[no-matching-overload]  # see email above.
    status: UserStatus = Field(default=UserStatus.ACTIVE, sa_type=_enum(UserStatus))


class IdentityBinding(SQLModel, table=True):
    """Provider-neutral binding owned by the canonical platform identity model.

    The preserved ``user_identities`` table stays in historical Alembic lineage
    for migration compatibility; target runtime identity uses this table.
    """

    __tablename__ = "identity_bindings"
    __table_args__ = (
        sa.UniqueConstraint("provider", "provider_subject", name="uq_identity_provider_subject"),
        sa.Index("ix_identity_bindings_user", "user_id"),
        {"schema": "platform"},
    )
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_id: uuid.UUID = Field(foreign_key="users.id", ondelete="CASCADE")
    provider: str = Field(sa_type=sa.Text)
    provider_subject: str = Field(sa_type=sa.Text)
    provider_email: str | None = Field(default=None, sa_type=sa.Text)
    # pyrefly: ignore[no-matching-overload]  # sa_type is not exposed in SQLModel stubs.
    created_at: dt.datetime = Field(
        sa_type=DateTime(timezone=True),
        nullable=False,
        sa_column_kwargs={"server_default": func.now()},
    )


class Membership(Timestamped, table=True):
    """The join, not a column on `users`: one person supporting two customers is
    the normal case the moment there is a second customer."""

    __tablename__ = "memberships"
    user_id: uuid.UUID = Field(foreign_key="users.id", ondelete="CASCADE", primary_key=True)
    tenant_id: uuid.UUID = Field(foreign_key="tenants.id", ondelete="CASCADE", primary_key=True)
    # pyrefly: ignore[no-matching-overload]  # see User.status above.
    role: Role = Field(sa_type=_enum(Role))


class MembershipPublic(BaseModel):
    tenant_id: uuid.UUID
    # Carried so the tenant switcher needs no second call.
    tenant_name: str
    role: Role


class UserPrincipal(BaseModel):
    """Everything the BFF needs to answer "who is this, and what may they reach".

    `status` is returned rather than 404'd on, so the BFF can say "account
    disabled" and "not invited" as the different things they are.
    """

    id: uuid.UUID
    email: str
    is_superuser: bool
    status: UserStatus
    memberships: list[MembershipPublic]
