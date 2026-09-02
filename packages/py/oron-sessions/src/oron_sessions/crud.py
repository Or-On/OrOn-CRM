import datetime as dt
import uuid
from typing import cast

import sqlalchemy as sa
from sqlalchemy import CursorResult, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from oron_sessions.campaigns import (
    Campaign,
    CampaignContact,
    CampaignCreate,
    CampaignProgress,
    ContactStatus,
)
from oron_sessions.contacts_file import ContactRow
from oron_sessions.crypto import FieldCipher, blind_index
from oron_sessions.models import Session, SessionCreate, SessionStatus, SessionUpdate


async def create_session(
    *,
    session: AsyncSession,
    session_in: SessionCreate,
    tenant_id: uuid.UUID,
    cipher: FieldCipher,
    blind_index_key: bytes,
) -> Session:
    # exclude_none so an omitted session_id falls back to the UUID default_factory.
    # from_number/to_number are popped out and encrypted separately — they must
    # never reach the Session constructor as plaintext.
    data = session_in.model_dump(exclude_none=True)
    from_number = data.pop("from_number", None)
    to_number = data.pop("to_number", None)
    obj = Session(**data, tenant_id=tenant_id)
    if from_number:
        obj.from_number = cipher.encrypt(tenant_id, from_number)
        obj.from_number_bidx = blind_index(from_number, blind_index_key)
    else:
        obj.from_number = from_number
    if to_number:
        obj.to_number = cipher.encrypt(tenant_id, to_number)
        obj.to_number_bidx = blind_index(to_number, blind_index_key)
    else:
        obj.to_number = to_number
    session.add(obj)
    await session.flush()
    await session.refresh(obj)
    return obj


async def get_session(*, session: AsyncSession, session_id: uuid.UUID) -> Session | None:
    return await session.get(Session, session_id)


async def update_session(
    *, session: AsyncSession, session_id: uuid.UUID, session_in: SessionUpdate
) -> Session | None:
    obj = await session.get(Session, session_id)
    if obj is None:
        return None
    updates = session_in.model_dump(exclude_unset=True)
    # Usage arrives as one nested model and lands on the row's own columns.
    if flattened := updates.pop("usage", None):
        updates |= flattened
    # Stamp ended_at server-side when a session is finalized and none was given.
    if (
        updates.get("status") == SessionStatus.ENDED
        and obj.ended_at is None
        and "ended_at" not in updates
    ):
        updates["ended_at"] = dt.datetime.now(dt.UTC)
    for key, value in updates.items():
        setattr(obj, key, value)
    session.add(obj)
    await session.flush()
    await session.refresh(obj)
    return obj


def _session_filters(
    *,
    since: dt.datetime | None,
    until: dt.datetime | None,
    answered: bool | None,
    outcome: str | None,
    number_bidx: str | None,
) -> list:
    """The where-clauses shared by the list and its count, so a filtered page
    can never disagree with the total above it."""
    clauses = []
    if since is not None:
        clauses.append(col(Session.created_at) >= since)
    if until is not None:
        clauses.append(col(Session.created_at) <= until)
    if answered is not None:
        clauses.append(col(Session.answered).is_(answered))
    if outcome is not None:
        clauses.append(col(Session.outcome) == outcome)
    if number_bidx is not None:
        # Searched by blind index, not by decrypting every row: the column is
        # ciphertext, so LIKE would match nothing and a scan-and-decrypt would
        # read the whole table to answer one query. Either end matches — the
        # person searching wants that number's calls, not one direction of them.
        clauses.append(
            sa.or_(
                col(Session.from_number_bidx) == number_bidx,
                col(Session.to_number_bidx) == number_bidx,
            )
        )
    return clauses


async def list_sessions(
    *,
    session: AsyncSession,
    limit: int = 50,
    offset: int = 0,
    since: dt.datetime | None = None,
    until: dt.datetime | None = None,
    answered: bool | None = None,
    outcome: str | None = None,
    number_bidx: str | None = None,
) -> list[Session]:
    result = await session.execute(
        select(Session)
        .where(
            *_session_filters(
                since=since,
                until=until,
                answered=answered,
                outcome=outcome,
                number_bidx=number_bidx,
            )
        )
        .order_by(col(Session.created_at).desc())
        .limit(limit)
        .offset(offset)
    )
    return list(result.scalars().all())


async def count_sessions(
    *,
    session: AsyncSession,
    since: dt.datetime | None = None,
    until: dt.datetime | None = None,
    answered: bool | None = None,
    outcome: str | None = None,
    number_bidx: str | None = None,
) -> int:
    result = await session.execute(
        select(func.count())
        .select_from(Session)
        .where(
            *_session_filters(
                since=since,
                until=until,
                answered=answered,
                outcome=outcome,
                number_bidx=number_bidx,
            )
        )
    )
    return int(result.scalar_one())


async def fail_stale_sessions(*, session: AsyncSession, older_than: dt.timedelta) -> int:
    """Mark sessions still `started` past `older_than` as `failed`.

    An agent that dies hard (SIGKILL, pod eviction) never finalizes its row, so
    without this a crashed call is indistinguishable from one still in progress.
    Returns the number of rows failed.
    """
    cutoff = dt.datetime.now(dt.UTC) - older_than
    result = await session.execute(
        update(Session)
        .where(col(Session.status) == SessionStatus.STARTED, col(Session.created_at) < cutoff)
        .values(status=SessionStatus.FAILED, ended_at=dt.datetime.now(dt.UTC))
    )
    await session.flush()
    # execute() is typed as returning Result; an UPDATE always yields a
    # CursorResult, which is what carries rowcount.
    return int(cast(CursorResult, result).rowcount)


# ---- campaigns -------------------------------------------------------------


async def create_campaign(
    *, session: AsyncSession, data: CampaignCreate, tenant_id: uuid.UUID
) -> Campaign:
    obj = Campaign(**data.model_dump(), tenant_id=tenant_id)
    session.add(obj)
    await session.flush()
    await session.refresh(obj)
    return obj


async def add_contacts(
    *,
    session: AsyncSession,
    campaign_id: uuid.UUID,
    tenant_id: uuid.UUID,
    contacts: list[ContactRow],
    cipher: FieldCipher,
    blind_index_key: bytes,
) -> int:
    """Store contacts with their numbers encrypted, and return how many landed.

    Numbers already present in this campaign are skipped rather than added
    again: an upload is often re-run after fixing a few rows, and the cost of
    getting that wrong is calling someone twice.
    """
    existing = set(
        (
            await session.execute(
                select(col(CampaignContact.phone_bidx)).where(
                    col(CampaignContact.campaign_id) == campaign_id
                )
            )
        ).scalars()
    )
    # A second upload appends to the queue rather than interleaving with it.
    position = (
        await session.scalar(
            select(func.coalesce(func.max(col(CampaignContact.position)) + 1, 0)).where(
                col(CampaignContact.campaign_id) == campaign_id
            )
        )
    ) or 0
    added = 0
    for contact in contacts:
        bidx = blind_index(contact.phone, blind_index_key)
        if bidx in existing:
            continue
        existing.add(bidx)
        session.add(
            CampaignContact(
                campaign_id=campaign_id,
                tenant_id=tenant_id,
                phone_number=cipher.encrypt(tenant_id, contact.phone),
                phone_bidx=bidx,
                data=contact.data,
                position=position,
            )
        )
        position += 1
        added += 1
    await session.flush()
    return added


async def claim_next_contact(
    *, session: AsyncSession, campaign_id: uuid.UUID
) -> CampaignContact | None:
    """Take the next pending contact and mark it `calling`, atomically.

    `FOR UPDATE SKIP LOCKED` is what makes a second runner — a redeploy overlap,
    two workers, a stuck loop restarted by hand — pick a different row instead of
    the same one. Without it the failure is not an error, it is the same person
    being dialled twice.
    """
    stmt = (
        select(CampaignContact)
        .where(
            col(CampaignContact.campaign_id) == campaign_id,
            col(CampaignContact.status) == ContactStatus.PENDING,
            # NULL is "never tried, dial now"; a timestamp is a redial resting
            # out its window. `IS NULL OR <= now` rather than a coalesce so the
            # claim index still applies.
            sa.or_(
                col(CampaignContact.next_attempt_at).is_(None),
                col(CampaignContact.next_attempt_at) <= dt.datetime.now(dt.UTC),
            ),
        )
        .order_by(col(CampaignContact.position))
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    contact = (await session.execute(stmt)).scalars().first()
    if contact is None:
        return None
    contact.status = ContactStatus.CALLING
    contact.attempts += 1
    contact.called_at = dt.datetime.now(dt.UTC)
    session.add(contact)
    await session.flush()
    return contact


async def finish_contact(
    *,
    session: AsyncSession,
    contact_id: uuid.UUID,
    status: ContactStatus,
    session_id: uuid.UUID | None = None,
    error: str | None = None,
) -> None:
    await session.execute(
        update(CampaignContact)
        .where(col(CampaignContact.id) == contact_id)
        .values(status=status, session_id=session_id, last_error=error)
    )


def _progress(counts: dict[ContactStatus, int]) -> CampaignProgress:
    return CampaignProgress(
        total=sum(counts.values()),
        pending=counts.get(ContactStatus.PENDING, 0),
        calling=counts.get(ContactStatus.CALLING, 0),
        called=counts.get(ContactStatus.CALLED, 0),
        no_answer=counts.get(ContactStatus.NO_ANSWER, 0),
        failed=counts.get(ContactStatus.FAILED, 0),
    )


async def campaign_progress(*, session: AsyncSession, campaign_id: uuid.UUID) -> CampaignProgress:
    counts = await progress_by_campaign(session=session, campaign_id=campaign_id)
    return counts.get(campaign_id, _progress({}))


async def progress_by_campaign(
    *, session: AsyncSession, campaign_id: uuid.UUID | None = None
) -> dict[uuid.UUID, CampaignProgress]:
    """Counts for every campaign this tenant owns, in one pass.

    One grouped scan rather than a progress query per row: measured at 50k
    contacts it costs the same 27ms as the single-campaign count the detail page
    already runs, where a dozen of those would cost twelve times that. Unscoped
    by campaign on purpose; RLS confines it to the tenant.
    """
    stmt = select(
        col(CampaignContact.campaign_id), col(CampaignContact.status), func.count()
    ).group_by(col(CampaignContact.campaign_id), col(CampaignContact.status))
    if campaign_id is not None:
        stmt = stmt.where(col(CampaignContact.campaign_id) == campaign_id)
    rows = (await session.execute(stmt)).all()
    counts: dict[uuid.UUID, dict[ContactStatus, int]] = {}
    for row_campaign_id, status, count in rows:
        counts.setdefault(row_campaign_id, {})[status] = count
    return {campaign_id: _progress(by_status) for campaign_id, by_status in counts.items()}
