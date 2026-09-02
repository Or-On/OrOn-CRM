import datetime as dt
import uuid

from sqlalchemy import DateTime, func
from sqlmodel import Field, SQLModel


class Timestamped(SQLModel):
    """Universal audit timestamps — timezone-aware UTC, server-managed.

    Uses sa_type + sa_column_kwargs (not sa_column) so SQLModel builds a fresh
    Column per subclass — a shared sa_column instance can't attach to two tables.
    """

    # pyrefly: ignore[no-matching-overload]  # sa_type/sa_column_kwargs are only
    # on the sa_column-less overload, which sqlmodel's stubs do not expose.
    created_at: dt.datetime | None = Field(
        default=None,
        sa_type=DateTime(timezone=True),
        nullable=False,
        sa_column_kwargs={"server_default": func.now()},
    )
    # pyrefly: ignore[no-matching-overload]  # see created_at above.
    updated_at: dt.datetime | None = Field(
        default=None,
        sa_type=DateTime(timezone=True),
        nullable=False,
        sa_column_kwargs={"server_default": func.now(), "onupdate": func.now()},
    )


class TenantScoped(Timestamped):
    """Timestamps + tenant scoping (single chain). Table models only; tenant_id
    is set server-side and enforced by RLS."""

    tenant_id: uuid.UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
