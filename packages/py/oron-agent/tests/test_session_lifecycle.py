"""The agent's session lifecycle: which status gets written, and when."""

import asyncio
import time
import uuid

import pytest
from oron_agent.session_recorder import SessionRecorder, finish_after_cancellation
from oron_agent.storage import GcsArtifactStore
from oron_common import CallContext, CallUsage
from oron_sessions import SessionStatus


class FakeSessionsClient:
    """Stands in for SessionsClient. `create_succeeds=False` mimics the API being
    unreachable — the real client returns None rather than raising."""

    def __init__(self, create_succeeds: bool = True):
        self._create_succeeds = create_succeeds
        self.finalized: list[SessionStatus] = []
        self.calls: list[dict] = []
        self.checkpoints: list[CallUsage] = []
        self.closed = False

    async def create(self, ctx, *, room):
        return uuid.uuid4() if self._create_succeeds else None

    async def finalize(self, session_id, *, status=SessionStatus.ENDED, **kw):
        self.finalized.append(status)
        self.calls.append({"status": status, **kw})
        return True

    async def checkpoint_usage(self, session_id, *, tenant_id, usage):
        self.checkpoints.append(usage)
        return True

    async def aclose(self):
        self.closed = True


def make_recorder(create_succeeds: bool = True):
    client = FakeSessionsClient(create_succeeds)
    ctx = CallContext(
        call_id="c1", direction="inbound", flow_id=uuid.uuid4(), tenant_id=uuid.uuid4()
    )
    store = GcsArtifactStore(bucket="oron-test")
    return client, ctx, SessionRecorder(client, ctx, store)


async def test_normal_end_writes_ended():
    client, _ctx, recorder = make_recorder()
    await recorder.start(room="r1")
    await recorder.finish(SessionStatus.ENDED, CallUsage())
    assert client.finalized == [SessionStatus.ENDED]


async def test_agent_error_writes_failed():
    """The gap this fixes: an agent that errored used to leave the row at
    `started` until the sweeper aged it out."""
    client, _ctx, recorder = make_recorder()
    await recorder.start(room="r1")
    await recorder.finish(SessionStatus.FAILED, CallUsage())
    assert client.finalized == [SessionStatus.FAILED]


async def test_clean_end_is_not_overwritten_by_a_teardown_error():
    client, _ctx, recorder = make_recorder()
    await recorder.start(room="r1")
    await recorder.finish(SessionStatus.ENDED, CallUsage())
    # error during teardown, after the end
    await recorder.finish(SessionStatus.FAILED, CallUsage())
    assert client.finalized == [SessionStatus.ENDED]


async def test_no_finalize_when_the_row_was_never_created():
    # create() returned None (API unreachable) — PATCHing would be a certain 404.
    client, _ctx, recorder = make_recorder(create_succeeds=False)
    await recorder.start(room="r1")
    await recorder.finish(SessionStatus.FAILED, CallUsage())
    assert client.finalized == []


async def test_finish_before_start_is_a_noop():
    client, _ctx, recorder = make_recorder()
    await recorder.finish(SessionStatus.FAILED, CallUsage())
    assert client.finalized == []


async def test_aclose_closes_the_client():
    client, _ctx, recorder = make_recorder()
    await recorder.aclose()
    assert client.closed is True


async def test_finalize_carries_the_tenant():
    """The agent authenticates with a *service* key, which the API rejects
    without X-Tenant-Id — so a finalize that omits the tenant is a 400 and the
    row keeps none of this call's usage."""
    client, ctx, recorder = make_recorder()
    await recorder.start(room="r1")
    await recorder.finish(SessionStatus.ENDED, CallUsage())
    assert client.calls[0]["tenant_id"] == ctx.tenant_id


async def test_live_usage_is_checkpointed_and_stops_at_finalize():
    client, _ctx, recorder = make_recorder()
    usage = CallUsage(llm_prompt_tokens=12, llm_model="gemini-2.5-flash")
    await recorder.start(room="r1")
    recorder.start_usage_reporting(
        usage,
        started_at=time.monotonic() - 2,
        interval_seconds=0.01,
    )

    await asyncio.sleep(0.025)
    assert client.checkpoints
    assert client.checkpoints[-1].call_seconds >= 2
    assert client.checkpoints[-1].llm_prompt_tokens == 12

    await recorder.finish(SessionStatus.ENDED, usage)
    count_after_finish = len(client.checkpoints)
    await asyncio.sleep(0.02)
    assert len(client.checkpoints) == count_after_finish


async def test_live_usage_reporting_requires_a_durable_session_row():
    client, _ctx, recorder = make_recorder(create_succeeds=False)
    await recorder.start(room="r1")
    recorder.start_usage_reporting(
        CallUsage(),
        started_at=time.monotonic(),
        interval_seconds=0.01,
    )
    await asyncio.sleep(0.02)
    assert client.checkpoints == []
    await recorder.aclose()


async def test_artifact_uris_are_derived_from_the_session_id():
    """Both URIs are always present — derived, never passed in, so a caller
    cannot forget or mistype one."""
    client, ctx, recorder = make_recorder()
    await recorder.start(room="r1")
    await recorder.finish(SessionStatus.ENDED, CallUsage())
    call = client.calls[0]
    sid = ctx.session_id
    assert (
        call["recording_uri"] == f"gs://oron-test/conversations/{sid}/recordings/merged_audio.wav"
    )
    assert (
        call["transcript_uri"] == f"gs://oron-test/conversations/{sid}/transcripts/transcript.txt"
    )


async def test_failed_sessions_carry_artifact_uris_too():
    """A call that died may still have uploaded a partial artifact, so the
    failed path is not a null-column special case."""
    client, ctx, recorder = make_recorder()
    await recorder.start(room="r1")
    await recorder.finish(SessionStatus.FAILED, CallUsage())
    call = client.calls[0]
    assert call["status"] is SessionStatus.FAILED
    assert str(ctx.session_id) in call["recording_uri"]
    assert str(ctx.session_id) in call["transcript_uri"]


async def test_cancelled_database_finalize_remains_retryable():
    client, _ctx, recorder = make_recorder()
    entered = asyncio.Event()
    release = asyncio.Event()
    attempts = 0

    async def delayed_finalize(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            entered.set()
            await release.wait()
        return True

    client.finalize = delayed_finalize
    await recorder.start(room="r1")
    first = asyncio.create_task(recorder.finish(SessionStatus.ENDED, CallUsage()))
    await entered.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    release.set()
    await recorder.finish(SessionStatus.ENDED, CallUsage())
    assert attempts == 2


async def test_rejected_database_finalize_remains_retryable():
    client, _ctx, recorder = make_recorder()
    results = iter((False, True))

    async def retryable_finalize(*args, **kwargs):
        return next(results)

    client.finalize = retryable_finalize
    await recorder.start(room="r1")

    assert await recorder.finish(SessionStatus.ENDED, CallUsage()) is False
    assert await recorder.finish(SessionStatus.ENDED, CallUsage()) is True


async def test_call_finalization_is_shielded_from_repeated_cancellation():
    entered = asyncio.Event()
    release = asyncio.Event()
    completed = False

    async def finalize():
        nonlocal completed
        entered.set()
        await release.wait()
        completed = True
        return True

    task = asyncio.create_task(finish_after_cancellation(finalize))
    await entered.wait()
    task.cancel()
    await asyncio.sleep(0)
    task.cancel()
    release.set()
    await task
    assert completed is True


async def test_call_finalization_has_a_hard_timeout():
    never_finishes = asyncio.Event()

    async def finalize():
        await never_finishes.wait()
        return True

    assert await finish_after_cancellation(finalize, timeout_seconds=0.01) is False


@pytest.mark.parametrize("status", [SessionStatus.ENDED, SessionStatus.FAILED])
async def test_status_is_the_enum_not_a_string(status):
    client, _ctx, recorder = make_recorder()
    await recorder.start(room="r1")
    await recorder.finish(status, CallUsage())
    assert client.finalized[0] is status
