import datetime as dt
import uuid
from enum import StrEnum
from typing import Annotated

import sqlalchemy as sa
from oron_common import CallUsage, Direction
from oron_db import TenantScoped
from pydantic import BaseModel, StringConstraints
from sqlmodel import Field, SQLModel


class SessionStatus(StrEnum):
    STARTED = "started"
    ENDED = "ended"
    FAILED = "failed"


# A URI column is either absent (NULL) or a real value — "" is not a third state.
NonEmptyStr = Annotated[str, StringConstraints(min_length=1)]


def _enum_column(enum_cls: type[StrEnum], **kwargs) -> sa.Column:
    """A native PostgreSQL enum type. Adding a value later needs ALTER TYPE ... ADD
    VALUE in its own migration."""
    return sa.Column(
        sa.Enum(
            enum_cls,
            name=enum_cls.__name__.lower(),
            # Persist the value ("inbound"), not the member name ("INBOUND"), so
            # rows read the same as the JSON the API serves.
            values_callable=lambda e: [m.value for m in e],
        ),
        **kwargs,
    )


class SessionBase(SQLModel):
    """Fields common to every session view — client input, table, and public
    response. `from_number`/`to_number` are NOT here: they're plaintext on
    `SessionCreate`, ciphertext on `Session`, and absent from `SessionPublic`
    (design D4 — the API never decrypts), so they can't share one type."""

    provider: str = "livekit"
    direction: Direction = Field(sa_column=_enum_column(Direction, nullable=False))
    # Always known at creation time — every session runs in a room.
    room: str
    # The flow is a property of the DID, not of the deployment.
    flow_id: uuid.UUID


class SessionCreate(SessionBase):
    # The agent supplies its own UUID; the server generates one if omitted.
    session_id: uuid.UUID | None = None
    # Client-supplied plaintext E.164 numbers. Encrypted server-side before
    # storage (oron_sessions.crud, oron_sessions.crypto) and never returned in
    # SessionPublic.
    from_number: str | None = None
    to_number: str | None = None


class SessionUpdate(SQLModel):
    status: SessionStatus | None = None
    # Outbound only — see Session.answered.
    answered: bool | None = None
    outcome: str | None = None
    recording_uri: NonEmptyStr | None = None
    transcript_uri: NonEmptyStr | None = None
    ended_at: dt.datetime | None = None
    # Nested, not seven optional twins of the columns: CallUsage is already the
    # one declaration of what a call consumed. Flattened onto the row in crud.
    usage: CallUsage | None = None


# CallUsage is mixed in, not restated: it is the one declaration of what a call
# consumed, and its fields become the row's columns. Not on SessionBase — a
# session is created before it has consumed anything, so SessionCreate must not
# offer them.
class Session(SessionBase, TenantScoped, CallUsage, table=True):
    __tablename__ = "sessions"
    __table_args__ = (
        sa.CheckConstraint("recording_uri <> ''", name="ck_sessions_recording_uri_nonempty"),
        sa.CheckConstraint("transcript_uri <> ''", name="ck_sessions_transcript_uri_nonempty"),
    )

    session_id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    status: SessionStatus = Field(
        default=SessionStatus.STARTED,
        sa_column=_enum_column(SessionStatus, nullable=False),
    )
    # Ciphertext ("v1:...", oron_sessions.crypto.FieldCipher) — encrypted
    # server-side on write (crud.create_session). Column stays `text`; only the
    # content changed, from plaintext E.164 to ciphertext.
    from_number: str | None = None
    to_number: str | None = None
    # Deterministic HMAC of the normalized E.164 from_number
    # (crypto.blind_index), under a key kept separate from the encryption DEK.
    # Lets right-to-erasure and ops lookups find a caller's rows by exact
    # match without ever decrypting.
    from_number_bidx: str | None = Field(default=None, index=True)
    # The same index for the callee. Without it "find every call to this number"
    # cannot work at all on an outbound dialer, which is most of the traffic —
    # the column is ciphertext, so there is nothing else to match on.
    to_number_bidx: str | None = Field(default=None, index=True)
    # Did the callee actually pick up? None for inbound, where the question does
    # not arise — somebody dialled us. For outbound this is the difference
    # between a conversation and a phone ringing in an empty room, and a
    # campaign that cannot tell them apart reports every unanswered number as
    # called.
    answered: bool | None = None
    # Which terminal node the flow ended on — the flow already names its endings
    # ("agreed", "refused", "callback"), so the business result of a call is
    # recorded rather than inferred from the transcript afterwards. NULL means
    # the call never reached one: hung up, failed, or nobody answered.
    outcome: str | None = None
    # Transcript and recording are blob-store artifacts under one prefix per
    # session; the row holds pointers, not the payloads.
    recording_uri: NonEmptyStr | None = None
    transcript_uri: NonEmptyStr | None = None
    # created_at (from TenantScoped/Timestamped) is the session start; ended_at is
    # the domain finish. tenant_id comes from TenantScoped, set server-side.
    ended_at: dt.datetime | None = Field(
        default=None, sa_column=sa.Column(sa.DateTime(timezone=True))
    )


# Usage is public so cost can be derived on read — a reader cannot re-price what
# the API withholds.
class SessionPublic(SessionBase, CallUsage):
    session_id: uuid.UUID
    tenant_id: uuid.UUID
    status: SessionStatus
    answered: bool | None = None
    outcome: str | None = None
    # Decrypted for the console. This is a deliberate loosening of design D4
    # ("the API never decrypts"): a call log that cannot say who was called, or
    # let the owner ring them back, is a list of timestamps. The numbers are
    # still encrypted at rest and still never leave the tenant's own scope.
    to_number: str | None = None
    from_number: str | None = None
    # Whatever the uploaded spreadsheet held for this person, when the call came
    # from a campaign. The console shows a name instead of digits.
    contact: dict | None = None
    # Derived on read from usage and the configured rates; None when no rates
    # are configured. Never stored — a price change would silently disagree
    # with history.
    cost_usd: float | None = None
    recording_uri: str | None = None
    transcript_uri: str | None = None
    created_at: dt.datetime
    updated_at: dt.datetime
    ended_at: dt.datetime | None = None


class Page[T](BaseModel):
    """Envelope shared by every paginated list response."""

    data: list[T]
    count: int
    limit: int
    offset: int
    has_more: bool


SessionsPublic = Page[SessionPublic]
