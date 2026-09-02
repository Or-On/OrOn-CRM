import datetime as dt
import uuid
from collections.abc import AsyncIterator

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from oron_common import PriceBook, price
from oron_common.phone import validate_e164
from oron_flows import Composition, FlowListing, FlowSpec, FlowStore, expand
from oron_flows.components import export_catalog
from oron_flows.seeds import SEED_COMPOSITIONS
from oron_tenancy import require_tenant
from oron_tenancy.flow_store import FlowNotFound
from pydantic import BaseModel, ValidationError
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from oron_sessions import contacts_file, crud
from oron_sessions.artifacts import (
    CONTENT_TYPE,
    ArtifactKind,
    ArtifactUnavailable,
    read_artifact,
)
from oron_sessions.campaigns import (
    Campaign,
    CampaignContact,
    CampaignCreate,
    CampaignListing,
    CampaignProgress,
    CampaignPublic,
    CampaignSettings,
    CampaignStatus,
    ContactPublic,
)
from oron_sessions.crypto import FieldCipher, blind_index
from oron_sessions.deps import (
    get_blind_index_key,
    get_field_cipher,
    get_flow_store,
    get_price_book,
    get_tenant_db,
)
from oron_sessions.models import (
    Session,
    SessionCreate,
    SessionPublic,
    SessionsPublic,
    SessionUpdate,
)

router = APIRouter()


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    sessionmaker = request.app.state.sessionmaker
    async with sessionmaker() as db:
        yield db


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)) -> dict:
    """Reports healthy only if the database this service exists to write to is
    actually reachable — a bare 200 would be green with Postgres down."""
    try:
        await db.execute(text("SELECT 1"))
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="database unavailable")
    return {"status": "ok"}


@router.get("/component-types")
async def component_types() -> dict:
    """The component catalog an editor renders forms and ports from.

    Untenanted on purpose: it describes the build, not anyone's data, and it is
    the same for every tenant. Derived from the step models by `build_spec`, so
    a new component appears here without anything being declared twice.
    """
    return export_catalog()


def _why_it_will_not_expand(exc: Exception) -> str:
    """The authored reason, without pydantic's apparatus.

    `expand` raises plain ValueError from the composition rules and
    ValidationError from FlowSpec's graph validators. Stringifying the latter
    whole drags in the entire rejected spec plus a docs URL, which buries the one
    sentence naming the step at fault — and this string is what an editor puts in
    front of whoever has to fix it.
    """
    if isinstance(exc, ValidationError):
        return "; ".join(e["msg"].removeprefix("Value error, ") for e in exc.errors())
    return str(exc)


class FlowPublished(BaseModel):
    """What a publish returns: enough to bind a DID to it, and nothing else."""

    flow_id: uuid.UUID
    version: int


@router.post("/flows", response_model=FlowPublished, status_code=201)
async def publish_flow(
    composition: Composition,
    store: FlowStore = Depends(get_flow_store),
    tenant_id: uuid.UUID = Depends(require_tenant),
) -> FlowPublished:
    """Expand, freeze and store a flow under the calling tenant.

    A published version is immutable here even though the store can overwrite one
    — that capability exists for boot-time convergence of the packaged catalog.
    Letting an author silently replace a version live would change what a DID
    already bound to it answers with, mid-traffic and with no reviewable diff.
    """
    if composition.flow.id in SEED_COMPOSITIONS:
        raise HTTPException(
            status_code=409, detail=f"flow id {composition.flow.id} belongs to the packaged catalog"
        )
    if composition.flow.version in await store.list_versions(str(tenant_id), composition.flow.id):
        raise HTTPException(
            status_code=409,
            detail=f"version {composition.flow.version} is already published; bump the version",
        )
    try:
        version = await store.publish(str(tenant_id), composition)
    except (ValidationError, ValueError) as exc:
        # The graph is only checked when it is expanded, so a composition that
        # parses can still describe an unreachable or dangling node.
        raise HTTPException(
            status_code=422, detail=f"flow does not expand: {_why_it_will_not_expand(exc)}"
        )
    return FlowPublished(flow_id=composition.flow.id, version=version)


@router.post("/flows/validate")
async def validate_flow(composition: Composition) -> dict:
    """Expand without storing, so an editor can show the error publish would raise.

    Deliberately the same `expand` the publish path calls: a validator that
    re-implements the rules is a validator that drifts from them, and the whole
    point is that a canvas which validates green also publishes green.
    """
    try:
        spec = expand(composition)
    except (ValidationError, ValueError) as exc:
        raise HTTPException(
            status_code=422, detail=f"flow does not expand: {_why_it_will_not_expand(exc)}"
        )
    return {"nodes": len(spec.nodes), "entry": spec.entry}


@router.get("/flows", response_model=list[FlowListing])
async def list_flows(
    store: FlowStore = Depends(get_flow_store),
    tenant_id: uuid.UUID = Depends(require_tenant),
) -> list[FlowListing]:
    """Every flow this tenant may open — its own, plus the packaged catalog."""
    return await store.list_flows(str(tenant_id))


@router.get("/flows/{flow_id}/versions", response_model=list[int])
async def flow_versions(
    flow_id: uuid.UUID,
    store: FlowStore = Depends(get_flow_store),
    tenant_id: uuid.UUID = Depends(require_tenant),
) -> list[int]:
    return await store.list_versions(str(tenant_id), flow_id)


@router.get("/flows/{flow_id}/source", response_model=Composition)
async def flow_source(
    flow_id: uuid.UUID,
    version: int | None = Query(default=None),
    store: FlowStore = Depends(get_flow_store),
    tenant_id: uuid.UUID = Depends(require_tenant),
) -> Composition:
    """What a human authored, for an editor to reopen. Omit `version` for latest."""
    try:
        return await store.load_source(str(tenant_id), flow_id, version)
    except FlowNotFound:
        raise HTTPException(status_code=404, detail="flow not found")


@router.get("/flows/{flow_id}", response_model=FlowSpec)
async def get_flow(
    flow_id: uuid.UUID,
    store: FlowStore = Depends(get_flow_store),
    tenant_id: uuid.UUID = Depends(require_tenant),
) -> FlowSpec:
    """The frozen spec a call should run: this tenant's flow, or the packaged one.

    Returns the latest version — a DID binds a flow_id and never a version, so
    "which version" is the store's decision, not the caller's.
    """
    try:
        return await store.load_latest(str(tenant_id), flow_id)
    except FlowNotFound:
        raise HTTPException(status_code=404, detail="flow not found")


@router.post("/sessions", response_model=SessionPublic, status_code=201)
async def create(
    data: SessionCreate,
    db: AsyncSession = Depends(get_tenant_db),
    tenant_id: uuid.UUID = Depends(require_tenant),
    cipher: FieldCipher = Depends(get_field_cipher),
    blind_index_key: bytes = Depends(get_blind_index_key),
    book: PriceBook = Depends(get_price_book),
) -> SessionPublic:
    try:
        row = await crud.create_session(
            session=db,
            session_in=data,
            tenant_id=tenant_id,
            cipher=cipher,
            blind_index_key=blind_index_key,
        )
    except IntegrityError:
        raise HTTPException(status_code=409, detail="session_id already exists")
    # Through the same serializer as the list: returning the row directly would
    # hand back ciphertext in a field the response model now calls plaintext.
    return (await _public([row], db, cipher, tenant_id, book))[0]


def _phone_hint(cipher: FieldCipher, tenant_id: uuid.UUID, ciphertext: str) -> str:
    """Last four digits, or a placeholder when this key cannot read the row."""
    try:
        return cipher.decrypt(tenant_id, ciphertext)[-4:]
    except Exception:
        return "????"


async def _public(
    rows: list[Session],
    db: AsyncSession,
    cipher: FieldCipher,
    tenant_id: uuid.UUID,
    book: PriceBook,
) -> list[SessionPublic]:
    """SessionPublic with the numbers decrypted and the caller named.

    Decrypting here is a deliberate loosening of design D4: a call log that
    cannot say who was called is a list of timestamps, and the owner needs the
    number to ring back. A number that will not decrypt is left empty rather
    than taking the page down with a 500.

    The name comes from the campaign contact that produced the call, looked up
    in one query for the whole page — a per-row lookup would be fifty round
    trips to render one screen.
    """
    contacts = {
        c.session_id: c.data
        for c in (
            await db.execute(
                select(CampaignContact).where(
                    col(CampaignContact.session_id).in_([r.session_id for r in rows] or [None])
                )
            )
        ).scalars()
    }

    def plain(value: str | None) -> str | None:
        if not value:
            return None
        try:
            return cipher.decrypt(tenant_id, value)
        except Exception:
            return None

    return [
        SessionPublic(
            **row.model_dump(exclude={"from_number", "to_number"}),
            to_number=plain(row.to_number),
            from_number=plain(row.from_number),
            contact=contacts.get(row.session_id),
            cost_usd=price(row, book).total,
        )
        for row in rows
    ]


@router.get("/sessions/{session_id}", response_model=SessionPublic)
async def get(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_tenant_db),
    cipher: FieldCipher = Depends(get_field_cipher),
    tenant_id: uuid.UUID = Depends(require_tenant),
    book: PriceBook = Depends(get_price_book),
) -> SessionPublic:
    obj = await crud.get_session(session=db, session_id=session_id)
    if obj is None:
        raise HTTPException(status_code=404, detail="session not found")
    return (await _public([obj], db, cipher, tenant_id, book))[0]


@router.patch("/sessions/{session_id}", response_model=SessionPublic)
async def patch(
    session_id: uuid.UUID,
    data: SessionUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    cipher: FieldCipher = Depends(get_field_cipher),
    tenant_id: uuid.UUID = Depends(require_tenant),
    book: PriceBook = Depends(get_price_book),
) -> SessionPublic:
    obj = await crud.update_session(session=db, session_id=session_id, session_in=data)
    if obj is None:
        raise HTTPException(status_code=404, detail="session not found")
    return (await _public([obj], db, cipher, tenant_id, book))[0]


@router.get("/sessions/{session_id}/artifact/{kind}")
async def artifact(
    session_id: uuid.UUID,
    kind: ArtifactKind,
    db: AsyncSession = Depends(get_tenant_db),
) -> Response:
    """Stream a call's recording or transcript.

    The URI is read off the session row, never taken from the request — the
    caller names a session and a kind, not a path. RLS scopes the lookup, so a
    session of another tenant is a 404 like any other unknown id.
    """
    row = await crud.get_session(session=db, session_id=session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    uri = row.recording_uri if kind is ArtifactKind.RECORDING else row.transcript_uri
    if not uri:
        raise HTTPException(status_code=404, detail=f"this call has no {kind}")
    try:
        return Response(content=await read_artifact(uri), media_type=CONTENT_TYPE[kind])
    except ArtifactUnavailable as exc:
        # 404, not 500: the row is fine, the bytes are not there.
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/sessions", response_model=SessionsPublic)
async def list_(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    since: dt.datetime | None = Query(default=None),
    until: dt.datetime | None = Query(default=None),
    answered: bool | None = Query(default=None),
    outcome: str | None = Query(default=None),
    number: str | None = Query(default=None, description="caller number, national or E.164"),
    region: str = Query(default="IL", description="region for a national-form number"),
    db: AsyncSession = Depends(get_tenant_db),
    cipher: FieldCipher = Depends(get_field_cipher),
    tenant_id: uuid.UUID = Depends(require_tenant),
    book: PriceBook = Depends(get_price_book),
    blind_index_key: bytes = Depends(get_blind_index_key),
) -> SessionsPublic:
    """Past calls, newest first, with the filters a list of thousands needs.

    `number` is matched through the blind index — the same normalisation the
    write path used — so it is an exact-number lookup, not a substring search.
    National form is accepted: `0544567890` finds `+972544567890`, because a
    person searching types the number the way they say it.
    Anything unparseable matches nothing rather than erroring: a half-typed
    number in a search box is not a client error.
    """
    number_bidx = None
    if number:
        try:
            number_bidx = blind_index(validate_e164(number, region), blind_index_key)
        except ValueError:
            return SessionsPublic(data=[], count=0, limit=limit, offset=offset, has_more=False)

    filters = dict(
        since=since, until=until, answered=answered, outcome=outcome, number_bidx=number_bidx
    )
    rows = await crud.list_sessions(session=db, limit=limit, offset=offset, **filters)
    count = await crud.count_sessions(session=db, **filters)
    return SessionsPublic(
        data=await _public(rows, db, cipher, tenant_id, book),
        count=count,
        limit=limit,
        offset=offset,
        has_more=offset + len(rows) < count,
    )


# ---- campaigns -------------------------------------------------------------


@router.post("/campaigns", response_model=CampaignPublic, status_code=201)
async def create_campaign(
    data: CampaignCreate,
    db: AsyncSession = Depends(get_tenant_db),
    tenant_id: uuid.UUID = Depends(require_tenant),
) -> Campaign:
    return await crud.create_campaign(session=db, data=data, tenant_id=tenant_id)


@router.get("/campaigns", response_model=list[CampaignListing])
async def list_campaigns(db: AsyncSession = Depends(get_tenant_db)) -> list[CampaignListing]:
    rows = await db.execute(select(Campaign).order_by(col(Campaign.created_at).desc()))
    progress = await crud.progress_by_campaign(session=db)
    return [
        CampaignListing(**c.model_dump(), progress=progress.get(c.id, CampaignProgress()))
        for c in rows.scalars()
    ]


@router.get("/campaigns/{campaign_id}", response_model=CampaignPublic)
async def get_campaign(
    campaign_id: uuid.UUID, db: AsyncSession = Depends(get_tenant_db)
) -> Campaign:
    obj = await db.get(Campaign, campaign_id)
    if obj is None:
        raise HTTPException(status_code=404, detail="campaign not found")
    return obj


@router.post("/campaigns/preview")
async def preview_contacts(
    file: UploadFile = File(...),
    # Parsing stores nothing, but it reads a customer list and echoes its
    # headers and first rows back — and buffers the upload to do it.
    _: uuid.UUID = Depends(require_tenant),
) -> dict:
    """Parse an upload and describe it, storing nothing.

    Two steps rather than one because the phone column is not guessed: the author
    sees the real headers and names the one to dial. A heuristic that is right
    most of the time is a heuristic that dials the wrong column the rest of it.
    """
    try:
        parsed = contacts_file.parse(await file.read(), file.filename or "")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {
        "columns": parsed.columns,
        "row_count": len(parsed.rows),
        "sample": parsed.rows[:5],
    }


@router.post("/campaigns/{campaign_id}/contacts")
async def upload_contacts(
    campaign_id: uuid.UUID,
    phone_column: str = Form(...),
    region: str = Form(default="IL"),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_tenant_db),
    tenant_id: uuid.UUID = Depends(require_tenant),
    cipher: FieldCipher = Depends(get_field_cipher),
    blind_index_key: bytes = Depends(get_blind_index_key),
) -> dict:
    """Import the list. Numbers are normalised to E.164 and encrypted here.

    Rejected rows come back rather than being dropped: a campaign that quietly
    imports 460 of 500 numbers is a campaign that under-runs without saying so.
    """
    campaign = await db.get(Campaign, campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="campaign not found")
    if campaign.status is CampaignStatus.RUNNING:
        raise HTTPException(status_code=409, detail="pause the campaign before adding contacts")

    try:
        parsed = contacts_file.parse(await file.read(), file.filename or "")
        contacts, rejected = contacts_file.to_contacts(parsed, phone_column, default_region=region)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    added = await crud.add_contacts(
        session=db,
        campaign_id=campaign_id,
        tenant_id=tenant_id,
        contacts=contacts,
        cipher=cipher,
        blind_index_key=blind_index_key,
    )
    return {
        "added": added,
        "duplicates_skipped": len(contacts) - added,
        "rejected": [r.model_dump() for r in rejected],
    }


class CorrectedRow(BaseModel):
    """One row the operator retyped in the console."""

    row: int
    phone: str
    data: dict[str, str] = {}


class CorrectedRows(BaseModel):
    contacts: list[CorrectedRow]
    region: str = "IL"


@router.post("/campaigns/{campaign_id}/contacts/corrected")
async def add_corrected_contacts(
    campaign_id: uuid.UUID,
    body: CorrectedRows,
    db: AsyncSession = Depends(get_tenant_db),
    tenant_id: uuid.UUID = Depends(require_tenant),
    cipher: FieldCipher = Depends(get_field_cipher),
    blind_index_key: bytes = Depends(get_blind_index_key),
) -> dict:
    """Import rows whose numbers were fixed by hand, keeping the rest of each row.

    The alternative — correct the spreadsheet and upload it again — asks the
    operator to find forty rows by number in a file of fifty thousand, and
    re-imports the other 49,960 to do it. This takes only what was retyped.

    Same normaliser as the upload, so a number that is still wrong comes back
    rejected with the same reason rather than being accepted by a second, looser
    path — and the response is the same shape, so one screen renders both.
    """
    campaign = await db.get(Campaign, campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="campaign not found")
    if campaign.status is CampaignStatus.RUNNING:
        raise HTTPException(status_code=409, detail="pause the campaign before adding contacts")

    contacts, rejected = contacts_file.normalize(
        [(c.row, c.phone.strip(), c.data) for c in body.contacts],
        default_region=body.region,
    )
    added = await crud.add_contacts(
        session=db,
        campaign_id=campaign_id,
        tenant_id=tenant_id,
        contacts=contacts,
        cipher=cipher,
        blind_index_key=blind_index_key,
    )
    return {
        "added": added,
        "duplicates_skipped": len(contacts) - added,
        "rejected": [r.model_dump() for r in rejected],
    }


@router.get("/campaigns/{campaign_id}/progress", response_model=CampaignProgress)
async def campaign_progress(
    campaign_id: uuid.UUID, db: AsyncSession = Depends(get_tenant_db)
) -> CampaignProgress:
    return await crud.campaign_progress(session=db, campaign_id=campaign_id)


@router.get("/campaigns/{campaign_id}/contacts", response_model=list[ContactPublic])
async def list_contacts(
    campaign_id: uuid.UUID,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_tenant_db),
    cipher: FieldCipher = Depends(get_field_cipher),
    tenant_id: uuid.UUID = Depends(require_tenant),
) -> list[ContactPublic]:
    rows = await db.execute(
        select(CampaignContact)
        .where(col(CampaignContact.campaign_id) == campaign_id)
        .order_by(col(CampaignContact.position))
        .limit(limit)
        .offset(offset)
    )
    return [
        ContactPublic(
            id=c.id,
            # Last four digits only. Listing progress is not a reason to hand a
            # customer list back in the clear. Unreadable rows show as "????"
            # rather than 500ing the page: the runner already fails such a
            # contact and leaves it here, so this is the screen that explains it.
            phone_hint=_phone_hint(cipher, tenant_id, c.phone_number),
            data=c.data,
            status=c.status,
            attempts=c.attempts,
            next_attempt_at=c.next_attempt_at,
            session_id=c.session_id,
            last_error=c.last_error,
            called_at=c.called_at,
        )
        for c in rows.scalars()
    ]


class CampaignControl(BaseModel):
    """The stop button and the settings form share one PATCH. Both are optional
    and an absent one changes nothing, so sending either does not clobber the
    other; `settings` arrives whole so `CampaignSettings` validates the window
    exactly as it does at creation."""

    status: CampaignStatus | None = None
    settings: CampaignSettings | None = None


@router.patch("/campaigns/{campaign_id}", response_model=CampaignPublic)
async def control_campaign(
    campaign_id: uuid.UUID,
    body: CampaignControl,
    db: AsyncSession = Depends(get_tenant_db),
) -> Campaign:
    """Start, pause or stop. The runner re-reads this before every dial, so a
    pause takes effect after the call in progress rather than at the end of the
    list — which is the only behaviour anyone wants from a stop button."""
    campaign = await db.get(Campaign, campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="campaign not found")
    if body.settings is not None:
        # Same rule as an upload: the dialer reads these between calls, so
        # changing the pace under a live campaign is a change nobody can predict
        # the effect of.
        if campaign.status is CampaignStatus.RUNNING:
            raise HTTPException(
                status_code=409, detail="pause the campaign before changing its settings"
            )
        for field, value in body.settings.model_dump().items():
            setattr(campaign, field, value)
    if body.status is CampaignStatus.RUNNING:
        pending = await crud.campaign_progress(session=db, campaign_id=campaign_id)
        if pending.pending == 0:
            raise HTTPException(status_code=409, detail="no contacts left to call")
    if body.status is not None:
        campaign.status = body.status
    db.add(campaign)
    await db.flush()
    await db.refresh(campaign)
    return campaign
