import asyncio
import base64
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI
from oron_common import PriceBook
from oron_db import make_engine, make_sessionmaker
from oron_flows import FlowStore
from oron_tenancy import SipSettings, build_sip_provisioner
from oron_tenancy import router as tenancy_router
from oron_tenancy.admission import converge_sip_admission
from oron_tenancy.flow_store import PostgresFlowStore
from oron_tenancy.models import Tenant
from oron_tenancy.provisioner import SipProvisioner
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col

from oron_sessions.api import router
from oron_sessions.config import load_settings
from oron_sessions.crypto import FieldCipher, build_field_cipher
from oron_sessions.dispatcher_client import DispatcherDialer
from oron_sessions.runner import CampaignRunner, PlaceCall, run_forever

# Long enough for a tick to finish, short enough to stay inside a pod's grace.
SHUTDOWN_GRACE_SECONDS = 20.0


def create_app(
    sessionmaker: async_sessionmaker[AsyncSession] | None = None,
    *,
    control_sessionmaker: async_sessionmaker[AsyncSession] | None = None,
    sip_settings: SipSettings | None = None,
    sip_provisioner: SipProvisioner | None = None,
    field_cipher: FieldCipher | None = None,
    blind_index_key: bytes | None = None,
    flow_store: FlowStore | None = None,
    place_call: PlaceCall | None = None,
) -> FastAPI:
    """Build the FastAPI app. Tests inject the two sessionmakers, a
    `field_cipher`/`blind_index_key`, and either a fake `sip_provisioner` or a
    `sip_settings` describing how to build one; production builds them from
    settings/env.

    Two sessionmakers, two DB roles: `sessionmaker` connects as the sessions
    role (call data under RLS, no grant on the credential tables) and
    `control_sessionmaker` as the tenancy role (control plane, no grant on
    `sessions`). Handing the wrong one to a dependency is a permission error at
    the database, not a silent widening.

    To run with provisioning DISABLED (registration then fails closed with 503),
    pass `sip_settings` with no LiveKit connection — e.g.
    `SipSettings(livekit_url=None)`. Passing `sip_provisioner=None` means
    "not provided", not "disabled".
    """

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        need_settings = (
            sessionmaker is None
            or control_sessionmaker is None
            or field_cipher is None
            or blind_index_key is None
        )
        settings = load_settings() if need_settings else None
        app.state.engines = []

        def resolve(
            injected: async_sessionmaker[AsyncSession] | None, url: str | None
        ) -> async_sessionmaker[AsyncSession]:
            if injected is not None:
                return injected
            assert url is not None  # need_settings is True whenever an injection is None
            engine = make_engine(url)
            app.state.engines.append(engine)
            return make_sessionmaker(engine)

        app.state.sessionmaker = resolve(sessionmaker, settings.database_url if settings else None)
        app.state.control_sessionmaker = resolve(
            control_sessionmaker, settings.control_database_url if settings else None
        )
        app.state.sip_provisioner = (
            sip_provisioner
            if sip_provisioner is not None
            else build_sip_provisioner(sip_settings or SipSettings())
        )

        # PostgreSQL is the sole runtime flow source. Publishing is an explicit
        # tenant action; process startup must never insert or refresh fictional
        # packaged flows behind an operator's back.
        app.state.flow_store = flow_store or PostgresFlowStore(app.state.sessionmaker)

        # A wiped LiveKit Redis admits nothing while every phone_numbers row still
        # names a rule, and that failure is silent — calls just stop arriving.
        if app.state.sip_provisioner is not None:
            await converge_sip_admission(
                provisioner=app.state.sip_provisioner,
                sessionmaker=app.state.control_sessionmaker,
            )

        if field_cipher is None:
            assert settings is not None  # need_settings is True whenever any is None
            local_key = (
                base64.b64decode(settings.field_cipher_local_key.get_secret_value())
                if settings.field_cipher_local_key
                else None
            )
            app.state.field_cipher = build_field_cipher(
                settings.field_cipher_backend,
                local_key=local_key,
                kms_key_name=settings.kms_key_name,
                kms_wrapped_dek=(
                    base64.b64decode(settings.kms_wrapped_dek.get_secret_value())
                    if settings.kms_wrapped_dek
                    else None
                ),
            )
        else:
            app.state.field_cipher = field_cipher

        if blind_index_key is None:
            assert settings is not None  # need_settings is True whenever any is None
            if not settings.blind_index_key:
                raise ValueError("blind index key required (set BLIND_INDEX_KEY)")
            decoded_blind_index_key = base64.b64decode(settings.blind_index_key.get_secret_value())
            if len(decoded_blind_index_key) < 32:
                raise ValueError(
                    f"BLIND_INDEX_KEY must decode to at least 32 bytes, "
                    f"got {len(decoded_blind_index_key)}"
                )
            app.state.blind_index_key = decoded_blind_index_key
        else:
            app.state.blind_index_key = blind_index_key

        # oron-common's book, the same one the agent prices with: one rate table
        # for the whole system rather than two that can disagree.
        app.state.price_book = PriceBook()

        # The campaign dialer. In-process rather than a CronJob: "one call at a
        # time" needs to notice the previous call ending within seconds, which a
        # minute-granularity cron cannot do. Safe to run in every replica —
        # claiming is `FOR UPDATE SKIP LOCKED` and in-flight state is a column.
        app.state.campaign_stop = asyncio.Event()
        app.state.campaign_task = None
        dialer = place_call
        if (
            dialer is None
            and settings
            and settings.enable_real_telephony
            and settings.dispatcher_url
        ):
            if not settings.outbound_api_token:
                raise ValueError("DISPATCHER_URL set without OUTBOUND_API_TOKEN")
            dialer = DispatcherDialer(
                settings.dispatcher_url, settings.outbound_api_token.get_secret_value()
            )
        if dialer is not None:
            control_sm = app.state.control_sessionmaker

            async def tenants() -> list[uuid.UUID]:
                # `tenants` is control-plane and carries no RLS policy — it is
                # what supplies the scopes the runner needs.
                async with control_sm() as session:
                    return list((await session.execute(select(col(Tenant.id)))).scalars())

            app.state.campaign_task = asyncio.create_task(
                run_forever(
                    CampaignRunner(
                        app.state.sessionmaker,
                        cipher=app.state.field_cipher,
                        place_call=dialer,
                        tenant_max_concurrent=(
                            settings.campaign_max_concurrent_per_tenant if settings else 20
                        ),
                    ),
                    tenants=tenants,
                    interval_seconds=settings.campaign_poll_seconds if settings else 5.0,
                    stop=app.state.campaign_stop,
                )
            )

        yield

        app.state.campaign_stop.set()
        if app.state.campaign_task is not None:
            # Bounded: `run_forever` only checks `stop` between ticks, and a tick
            # can be parked on the tenant advisory lock or on a dial. Waiting
            # forever means the pod outlives its termination grace period and is
            # SIGKILLed mid-call instead of finishing the one in flight.
            try:
                await asyncio.wait_for(app.state.campaign_task, timeout=SHUTDOWN_GRACE_SECONDS)
            except TimeoutError:
                app.state.campaign_task.cancel()
        if isinstance(dialer, DispatcherDialer):
            await dialer.aclose()
        for engine in app.state.engines:
            await engine.dispose()

    app = FastAPI(title="oron-sessions", lifespan=lifespan)
    app.include_router(router)
    # Control plane is a separate package with its own router and its own
    # (untenanted) session handling. Mounted here for now because both planes
    # share a database and a deployment; splitting the process later only needs
    # this line moved, not the code rearranged.
    app.include_router(tenancy_router)
    return app


app = create_app()


def main() -> None:
    import uvicorn
    from oron_secrets import hydrate_env_from_secret_manager

    # Resolve SECRET__* refs (e.g. SECRET__DATABASE_URL) before the lifespan reads
    # settings. The env change persists for the uvicorn worker in this process.
    hydrate_env_from_secret_manager()
    uvicorn.run(
        "oron_sessions.app:app",
        host="0.0.0.0",  # noqa: S104 - container entrypoint must accept routed traffic
        port=load_settings().port,
    )


if __name__ == "__main__":
    main()
