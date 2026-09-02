"""The campaign dialer: claim a contact, place a call, wait, repeat.

Lives here rather than in the dispatcher because this is the service that holds
the cipher. A contact's number is encrypted at rest, and decrypting it is the one
thing the dialer must do — doing it here means the plaintext crosses exactly the
boundary it already crosses today (`POST /calls` takes a number), and no new one.

**In-flight state is a database column, not a variable.** A contact being dialled
is `calling` in `campaign_contacts`; the loop holds nothing. So a redeploy
mid-campaign resumes instead of restarting, two runners cannot claim the same row
(`FOR UPDATE SKIP LOCKED`), and "one call at a time" survives a process dying —
which a counter in memory would not.

Scoped one tenant at a time, for the same reason the sweeper is: `campaign_contacts`
is under RLS, and an unscoped query matches nothing while looking exactly like a
campaign with no work left.
"""

import asyncio
import datetime as dt
import logging
import uuid
from contextlib import suppress
from typing import Protocol
from zoneinfo import ZoneInfo

from oron_db import set_tenant
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col

from oron_sessions import crud
from oron_sessions.campaigns import Campaign, CampaignContact, CampaignStatus, ContactStatus
from oron_sessions.crypto import FieldCipher
from oron_sessions.models import Session, SessionStatus

logger = logging.getLogger(__name__)

# How many dials may fail back-to-back before a campaign stops for this tick.
# Low on purpose: the signal it is looking for is "the dispatcher is down", and
# three in a row already says that.
MAX_CONSECUTIVE_DIAL_FAILURES = 3


class Clock(Protocol):
    """Just `now()`. Annotating this as `type[datetime]` said the seam existed
    while forbidding the only thing anyone would inject into it."""

    def now(self, tz: dt.tzinfo | None = None) -> dt.datetime: ...


class PlaceCall(Protocol):
    """Dial one number for one tenant and return the session id it created.

    Injected rather than imported: in production it posts to the dispatcher's
    `/calls`, and in tests it is a list. The runner never learns which.
    """

    async def __call__(
        self, *, phone_number: str, tenant_id: uuid.UUID, flow_id: uuid.UUID
    ) -> uuid.UUID: ...


class CampaignRunner:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        cipher: FieldCipher,
        place_call: PlaceCall,
        stuck_after: dt.timedelta = dt.timedelta(minutes=15),
        tenant_max_concurrent: int = 20,
        now: Clock = dt.datetime,
    ):
        self._sessionmaker = sessionmaker
        self._cipher = cipher
        self._place_call = place_call
        self._stuck_after = stuck_after
        # What the trunk and the agent fleet can carry, not what one list wants.
        # `max_concurrent` is per campaign, so without this N running campaigns
        # multiply: ten campaigns at 20 is 200 simultaneous calls and nothing
        # objects.
        self._tenant_max_concurrent = tenant_max_concurrent
        self._now = now

    async def tick(self, tenant_id: uuid.UUID) -> int:
        """One pass for one tenant. Returns how many calls it placed.

        Reconcile before dialling, always: a contact still counted as in-flight
        is a contact whose slot is not free, and with `max_concurrent = 1` that
        is the difference between the campaign advancing and stalling forever.

        Paused campaigns are reconciled too, and only then skipped. Pausing does
        not cancel the call already ringing, so a paused campaign that never
        reconciled would show that contact as `calling` forever — a finished call
        displayed as one still in progress.
        """
        placed = 0
        async with self._sessionmaker() as session, session.begin():
            await set_tenant(session, tenant_id)
            campaigns = list(
                (
                    await session.execute(
                        select(Campaign).where(
                            col(Campaign.status).in_(
                                [CampaignStatus.RUNNING, CampaignStatus.PAUSED]
                            )
                        )
                    )
                ).scalars()
            )

        for campaign in campaigns:
            placed += await self._advance(tenant_id, campaign)
        return placed

    async def _advance(self, tenant_id: uuid.UUID, campaign: Campaign) -> int:
        await self._reconcile(tenant_id, campaign)

        if campaign.status is not CampaignStatus.RUNNING:
            return 0

        now = self._now.now(dt.UTC)
        # Outside the calling window we stop *starting* calls. Reconcile above
        # still runs, and a call already in progress is never cut off — the rule
        # is about when a stranger's phone may ring, not about hanging up on one
        # who answered at 19:59.
        if not self._within_calling_window(campaign, now):
            return 0

        placed = 0
        consecutive_failures = 0
        while True:
            async with self._sessionmaker() as session, session.begin():
                await set_tenant(session, tenant_id)

                # Re-read the status every iteration, not once per tick: pause
                # has to take effect after the current call, not after the batch.
                #
                # `FOR UPDATE` on the campaign, not SKIP LOCKED: this is what
                # serialises the count-then-claim below across replicas. Without
                # it two runners both read `in_flight = 0` before either commits,
                # SKIP LOCKED hands them *different* contacts — no row is claimed
                # twice, and `max_concurrent = 1` still places two calls at once.
                # Tenant gate first, campaign row second — one lock order
                # everywhere, so two runners on different campaigns of the same
                # tenant cannot deadlock against each other.
                await self._lock_tenant(session, tenant_id)

                current = await session.get(Campaign, campaign.id, with_for_update=True)
                if current is None or current.status is not CampaignStatus.RUNNING:
                    return placed

                if await self._tenant_in_flight(session) >= self._tenant_max_concurrent:
                    return placed

                in_flight = await self._in_flight(session, campaign.id)
                if in_flight >= current.max_concurrent:
                    return placed

                contact = await crud.claim_next_contact(session=session, campaign_id=campaign.id)
                if contact is None:
                    # Nothing claimable. That is not the same as nothing left:
                    # a contact resting out its retry window is still pending and
                    # will be dialled later, so finishing here would report a
                    # campaign complete with numbers it has yet to redial.
                    if in_flight == 0 and not await self._has_pending(session, campaign.id):
                        current.status = CampaignStatus.DONE
                        session.add(current)
                    return placed

                try:
                    number = self._cipher.decrypt(tenant_id, contact.phone_number)
                except Exception as exc:
                    # A number this key cannot read is one dead contact, not a
                    # dead campaign: letting it raise rolls the claim back, so
                    # the next tick picks the same row and every campaign this
                    # tenant owns stops for good.
                    logger.warning(
                        "campaign %s: contact %s unreadable (%s)",
                        campaign.id,
                        contact.id,
                        type(exc).__name__,
                    )
                    contact.status = ContactStatus.FAILED
                    contact.last_error = "המספר אינו קריא"
                    session.add(contact)
                    continue
                contact_id = contact.id

            # Dialling outside the transaction: it is a network call to another
            # service, and holding a row lock across it would block the very
            # reconcile that frees the slot.
            try:
                session_id = await self._place_call(
                    phone_number=number, tenant_id=tenant_id, flow_id=campaign.flow_id
                )
            except Exception as exc:
                safe_error = type(exc).__name__
                logger.warning("campaign %s: dial failed (%s)", campaign.id, safe_error)
                await self._finish(tenant_id, contact_id, ContactStatus.FAILED, error=safe_error)
                # A dispatcher that is restarting, out of credit or refusing
                # connections fails instantly for every number, and a hard
                # failure is never redialled — so without this one outage walks
                # the whole list and marks it all failed, permanently. Stop the
                # campaign's tick instead and leave the rest pending; the next
                # tick is seconds away and costs nothing if the outage is over.
                consecutive_failures += 1
                if consecutive_failures >= MAX_CONSECUTIVE_DIAL_FAILURES:
                    logger.error(
                        "campaign %s: %d dials failed in a row — pausing this tick",
                        campaign.id,
                        consecutive_failures,
                    )
                    return placed
                continue
            consecutive_failures = 0

            async with self._sessionmaker() as session, session.begin():
                await set_tenant(session, tenant_id)
                await session.execute(
                    update(CampaignContact)
                    .where(col(CampaignContact.id) == contact_id)
                    .values(session_id=session_id)
                )
            placed += 1

    async def _in_flight(self, session: AsyncSession, campaign_id: uuid.UUID) -> int:
        return (
            await session.scalar(
                select(func.count())
                .select_from(CampaignContact)
                .where(
                    col(CampaignContact.campaign_id) == campaign_id,
                    col(CampaignContact.status) == ContactStatus.CALLING,
                )
            )
        ) or 0

    @staticmethod
    def _within_calling_window(campaign: Campaign, now: dt.datetime) -> bool:
        """Is it an acceptable hour where the callee lives?

        Evaluated per tick rather than scheduled once: a campaign that spans days
        crosses the window in both directions many times, and a DST shift moves
        it under a running campaign.
        """
        local = now.astimezone(ZoneInfo(campaign.timezone))
        # A day with no hours is a day nobody is called. Keys survive JSON as
        # strings, so the lookup takes both rather than trusting the round trip.
        hours = campaign.weekday_hours.get(local.weekday()) or campaign.weekday_hours.get(
            str(local.weekday())  # type: ignore[arg-type]
        )
        if not hours:
            return False
        return hours[0] <= local.hour < hours[1]

    async def _lock_tenant(self, session: AsyncSession, tenant_id: uuid.UUID) -> None:
        """Serialise every runner working for this tenant, for this transaction.

        An advisory lock rather than a row lock: the tenant ceiling spans all of
        a tenant's campaigns, so there is no single row to take — and `tenants`
        lives in the control plane, which the sessions role has no grant on.
        Released automatically at commit or rollback.
        """
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:tenant, 0))"),
            {"tenant": str(tenant_id)},
        )

    async def _tenant_in_flight(self, session: AsyncSession) -> int:
        """In-flight across every campaign of this tenant. Unfiltered by campaign
        on purpose; RLS already scopes the query to the tenant."""
        return (
            await session.scalar(
                select(func.count())
                .select_from(CampaignContact)
                .where(col(CampaignContact.status) == ContactStatus.CALLING)
            )
        ) or 0

    async def _has_pending(self, session: AsyncSession, campaign_id: uuid.UUID) -> bool:
        """Any contact still owed a dial, including one resting for a redial."""
        return bool(
            await session.scalar(
                select(func.count())
                .select_from(CampaignContact)
                .where(
                    col(CampaignContact.campaign_id) == campaign_id,
                    col(CampaignContact.status) == ContactStatus.PENDING,
                )
            )
        )

    async def _reconcile(self, tenant_id: uuid.UUID, campaign: Campaign) -> None:
        """Move `calling` contacts on once their call has actually finished.

        A contact whose session ended is done. A contact whose session never
        appeared at all is released after `stuck_after` — otherwise a dial that
        produced nothing pins a sequential campaign forever, and it does so
        silently, looking exactly like a campaign still running.

        A session that exists and is still `started` is a call still in progress,
        however long it has run, so the timeout deliberately does NOT apply to it:
        releasing that slot would dial the next contact over a live call and break
        `max_concurrent`. A session whose agent died is the sweeper's job — it
        fails the row after `stale_session_minutes`, and that lands here as a
        finished session on the next tick.
        """
        now = self._now.now(dt.UTC)
        cutoff = now - self._stuck_after
        async with self._sessionmaker() as session, session.begin():
            await set_tenant(session, tenant_id)
            rows = list(
                (
                    await session.execute(
                        select(CampaignContact).where(
                            col(CampaignContact.campaign_id) == campaign.id,
                            col(CampaignContact.status) == ContactStatus.CALLING,
                        )
                    )
                ).scalars()
            )
            for contact in rows:
                call = (
                    await session.get(Session, contact.session_id) if contact.session_id else None
                )
                if call is not None and call.status is not SessionStatus.STARTED:
                    self._settle(contact, self._outcome(call), campaign, now)
                    session.add(contact)
                elif call is None and contact.called_at and contact.called_at < cutoff:
                    contact.last_error = "the dial never produced a call"
                    self._settle(contact, ContactStatus.FAILED, campaign, now)
                    session.add(contact)

    @staticmethod
    def _outcome(call: Session) -> ContactStatus:
        """What the finished call means for the contact.

        `answered is False` is the case worth naming: the agent greets a ringing
        line when the carrier never reports a pick-up, so an unanswered number
        finalizes as a perfectly ordinary `ended` session. Counting that as
        `called` is how a campaign reports 500/500 with half the list never
        having spoken to anyone.
        """
        if call.status is not SessionStatus.ENDED:
            return ContactStatus.FAILED
        return ContactStatus.CALLED if call.answered is not False else ContactStatus.NO_ANSWER

    def _settle(
        self,
        contact: CampaignContact,
        outcome: ContactStatus,
        campaign: Campaign,
        now: dt.datetime,
    ) -> None:
        """Apply an outcome, or put the contact back for a redial.

        Only `no_answer` is retried. A number that rang out is worth a second
        occasion; a hard failure — bad number, no trunk, no credit — repeats
        identically, so redialling it just burns the attempt budget on a call
        that cannot succeed.
        """
        if outcome is ContactStatus.NO_ANSWER and contact.attempts < campaign.max_attempts:
            contact.status = ContactStatus.PENDING
            contact.next_attempt_at = now + dt.timedelta(minutes=campaign.retry_after_minutes)
            contact.session_id = None
            return
        contact.status = outcome

    async def _finish(
        self,
        tenant_id: uuid.UUID,
        contact_id: uuid.UUID,
        status: ContactStatus,
        *,
        error: str | None = None,
    ) -> None:
        async with self._sessionmaker() as session, session.begin():
            await set_tenant(session, tenant_id)
            await crud.finish_contact(
                session=session, contact_id=contact_id, status=status, error=error
            )


async def run_forever(
    runner: CampaignRunner,
    *,
    tenants: TenantSource,
    interval_seconds: float = 5.0,
    stop: asyncio.Event | None = None,
) -> None:
    """Poll every `interval_seconds`. Polling, not a queue: the loop is idle
    unless a campaign is running, one Postgres round trip is cheaper than a
    broker to operate, and the work is already transactional in the database.

    ponytail: tenants advance one at a time with the dial inline, so a tenant
    whose dispatcher HANGS (rather than fails, which the consecutive-failure
    break catches) stalls every other tenant for the length of its timeouts.
    Upgrade path: a per-tenant time budget around `tick`, then a bounded pool.
    See `Or-On/Outbound Campaigns (#61) — Known Debt`.
    """
    stop = stop or asyncio.Event()
    while not stop.is_set():
        try:
            for tenant_id in await tenants():
                await runner.tick(tenant_id)
        except Exception:  # a bad tick must not end the loop
            logger.exception("campaign runner tick failed")
        with suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval_seconds)


class TenantSource(Protocol):
    async def __call__(self) -> list[uuid.UUID]: ...
