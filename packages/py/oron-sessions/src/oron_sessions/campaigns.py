"""Campaigns: dial a list of numbers through one flow, one call at a time.

The rows come from a spreadsheet the tenant uploads. Each becomes a contact with
its phone number **encrypted exactly like a session's** — same cipher, same
per-tenant key — because an uploaded customer list is the same PII a call record
holds, and storing it in the clear beside an encrypted copy of the same number
would make the encryption decorative.

Everything else on the row is kept verbatim in `data`, so a flow can interpolate
it (`${first_name}`) without the schema having to know what a tenant's
spreadsheet contains.
"""

import datetime as dt
import uuid
from enum import StrEnum
from zoneinfo import ZoneInfo

import sqlalchemy as sa
from oron_db import TenantScoped
from pydantic import BaseModel, model_validator
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

from oron_sessions.models import Page, _enum_column

# Sunday to Thursday full, Friday short, Saturday closed — an Israeli working
# week, which is who this dials. Keyed by datetime.weekday(): Mon=0 … Sun=6.
DEFAULT_WEEKDAY_HOURS: dict[int, list[int]] = {
    6: [9, 18],  # Sunday
    0: [9, 18],
    1: [9, 18],
    2: [9, 18],
    3: [9, 18],
    4: [9, 14],  # Friday — a short day, not a Tuesday
}


class CampaignStatus(StrEnum):
    DRAFT = "draft"
    RUNNING = "running"
    PAUSED = "paused"
    DONE = "done"


class ContactStatus(StrEnum):
    """Terminal states are `called`, `no_answer` and `failed`. `no_answer` is
    kept apart from `failed` because it is the only one worth redialling: the
    number was fine and nobody picked up."""

    PENDING = "pending"
    CALLING = "calling"
    CALLED = "called"
    NO_ANSWER = "no_answer"
    FAILED = "failed"


class CampaignSettings(SQLModel):
    """The knobs that decide when and how fast this campaign dials.

    Split from the identity fields because these are the ones a PATCH may
    replace after creation — sending them as a block keeps the window rules
    below as the single place they are validated.
    """

    # This is a dialer. The ceiling is per-campaign rather than a constant because
    # "one at a time" is the safe default and anything above it is a decision
    # someone has to make deliberately, not a value that drifts in from config.
    max_concurrent: int = Field(default=1, ge=1, le=20)
    # Total dials per contact, including the first. 1 = never redial.
    max_attempts: int = Field(default=1, ge=1, le=5)
    # How long an unanswered number rests before it is offered again. Long
    # enough that a redial is a second occasion, not the same phone ringing
    # twice.
    retry_after_minutes: int = Field(default=60, ge=1)
    # The calling window, in the callee's own time: a big list runs for days or
    # weeks, so without an hours rule a campaign started on Monday is still
    # dialling strangers at 03:00 on Friday.
    # IANA name, not a UTC offset: DST is not the author's problem to remember.
    timezone: str = "Asia/Jerusalem"
    # Hours per weekday rather than one pair for the whole week: a week is not
    # uniform. In Israel Friday is a short day and Saturday is not a day at all,
    # and one from/to plus a list of skipped days cannot say the first of those.
    # A day absent from the map is a day nobody is called — so this replaces the
    # separate quiet-days list rather than sitting beside it.
    # Keyed by `datetime.weekday()`, Monday=0, because that is what the runner
    # compares against; the console renders the week Sunday-first for the reader.
    # pyrefly: ignore[no-matching-overload]  # sa_type lives on the
    # sa_column-less overload, which sqlmodel's stubs do not expose.
    weekday_hours: dict[int, list[int]] = Field(
        default_factory=lambda: DEFAULT_WEEKDAY_HOURS.copy(), sa_type=JSONB, nullable=False
    )

    @model_validator(mode="after")
    def _window_is_a_window(self) -> CampaignSettings:
        """Fail here, not at the first dial three layers deeper."""
        try:
            ZoneInfo(self.timezone)
        except Exception:
            raise ValueError(f"unknown timezone {self.timezone!r}")
        for day, hours in self.weekday_hours.items():
            if day < 0 or day > 6:
                raise ValueError("weekday keys are 0..6, Monday=0")
            if len(hours) != 2:
                raise ValueError(f"day {day} needs exactly [from, to]")
            start, end = hours
            if not 0 <= start < end <= 24:
                raise ValueError(f"day {day}: 0 <= from < to <= 24, got {start}-{end}")
        return self


class CampaignBase(CampaignSettings):
    name: str
    flow_id: uuid.UUID


class CampaignCreate(CampaignBase):
    pass


class Campaign(CampaignBase, TenantScoped, table=True):
    __tablename__ = "campaigns"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    status: CampaignStatus = Field(
        default=CampaignStatus.DRAFT,
        sa_column=_enum_column(CampaignStatus, nullable=False),
    )


class CampaignContact(TenantScoped, table=True):
    __tablename__ = "campaign_contacts"
    __table_args__ = (
        # One row per number per campaign, enforced here rather than by the
        # importer remembering to check. Duplicates in an exported spreadsheet
        # are normal; dialling the same person twice is not.
        sa.UniqueConstraint("campaign_id", "phone_bidx", name="uq_campaign_contact_number"),
        # The claim query: eligible pending rows of one campaign, in dial order.
        # Its `campaign_id` prefix also serves the plain lookups and the progress
        # counts, so neither needs an index of its own.
        # `next_attempt_at` before `position`: without it the claim walks every
        # pending row checking the timestamp — a full index scan whenever
        # contacts are resting for a redial.
        sa.Index(
            "ix_campaign_contacts_claim",
            "campaign_id",
            "status",
            "next_attempt_at",
            "position",
        ),
        # Every session read joins by this to put a name beside the number, and
        # that happens on call setup and call finalize as well as on the list.
        sa.Index("ix_campaign_contacts_session_id", "session_id"),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    # Deleting a campaign takes its contacts with it — an orphaned contact is a
    # number nothing will ever dial and nothing will ever clean up.
    campaign_id: uuid.UUID = Field(foreign_key="campaigns.id", ondelete="CASCADE")
    # Dial order = file order. Not created_at: every row of one upload shares a
    # transaction, and now() is transaction time, so they all tie.
    position: int = 0
    # Ciphertext, never the number. Same FieldCipher and per-tenant key as
    # sessions.to_number.
    phone_number: str
    # Deterministic HMAC of the E.164 form, so the same person can be found —
    # and suppressed — across campaigns without decrypting anything.
    phone_bidx: str = Field(index=True)
    # The rest of the spreadsheet row, verbatim.
    # pyrefly: ignore[no-matching-overload]  # sa_type is only on the
    # sa_column-less overload, which sqlmodel's stubs do not expose.
    data: dict = Field(default_factory=dict, sa_type=JSONB, nullable=False)
    status: ContactStatus = Field(
        default=ContactStatus.PENDING,
        sa_column=_enum_column(ContactStatus, nullable=False),
    )
    attempts: int = 0
    # Set when an unanswered contact goes back in the queue; it is invisible to
    # the claim query until then. NULL means "eligible now", which is every
    # contact that has not been tried.
    next_attempt_at: dt.datetime | None = Field(
        default=None, sa_column=sa.Column(sa.DateTime(timezone=True))
    )
    session_id: uuid.UUID | None = None
    last_error: str | None = None
    called_at: dt.datetime | None = Field(
        default=None, sa_column=sa.Column(sa.DateTime(timezone=True))
    )


class CampaignPublic(CampaignBase):
    id: uuid.UUID
    tenant_id: uuid.UUID
    status: CampaignStatus
    created_at: dt.datetime
    updated_at: dt.datetime


class ContactPublic(BaseModel):
    """A contact as the console sees it.

    `phone_number` is deliberately absent — the console lists progress, and a
    list view is not a reason to decrypt a customer list. `phone_hint` is the
    last four digits, enough to recognise a row you are looking at.
    """

    id: uuid.UUID
    phone_hint: str
    data: dict
    status: ContactStatus
    attempts: int
    # A contact resting for a redial is `pending` with a timestamp. Without this
    # the console shows a tried-and-unanswered row identically to one never
    # dialled, which reads as "nothing has happened yet".
    next_attempt_at: dt.datetime | None
    session_id: uuid.UUID | None
    last_error: str | None
    called_at: dt.datetime | None


class CampaignProgress(BaseModel):
    """Counts by status, so the console can show progress without paging every
    contact of a 10,000-row campaign.

    Zero is the honest default: a campaign nobody has uploaded a list into has
    no contacts in any state.
    """

    total: int = 0
    pending: int = 0
    calling: int = 0
    called: int = 0
    no_answer: int = 0
    failed: int = 0


class CampaignListing(CampaignPublic):
    """A campaign as the list page shows it. Without the counts the list is a
    dozen names and no way to tell which one has done anything."""

    progress: CampaignProgress


CampaignsPublic = Page[CampaignPublic]
ContactsPublic = Page[ContactPublic]
