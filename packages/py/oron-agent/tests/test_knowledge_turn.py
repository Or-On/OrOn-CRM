"""Per-call knowledge reuse never replaces fresh point-of-use authorization."""

import asyncio
from copy import deepcopy

import pytest
from oron_agent.knowledge_turn import TurnKnowledgeReader


@pytest.mark.asyncio
async def test_one_full_load_per_turn_and_fresh_checks_for_every_selector():
    counts = {"loads": 0, "checks": 0}
    records = [{"tenantId": "one", "eligibilityRevision": "one/doc/1/hash", "facts": []}]

    async def load():
        counts["loads"] += 1
        return deepcopy(records)

    async def check():
        counts["checks"] += 1
        return ["one/doc/1/hash"]

    reader = TurnKnowledgeReader(load, check)
    await reader.begin_turn()
    first = await reader.for_speech()
    first[0]["tenantId"] = "tampered"
    assert (await reader.for_speech())[0]["tenantId"] == "one"
    assert counts == {"loads": 1, "checks": 2}
    await reader.begin_turn()
    assert counts["loads"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("revision", [[], ["new/version"], ["same/doc/new-hash"]])
async def test_revocation_expiry_or_content_change_cannot_reuse_snapshot(revision):
    async def load():
        return [{"eligibilityRevision": "original"}]

    async def check():
        return revision

    reader = TurnKnowledgeReader(load, check)
    await reader.begin_turn()
    assert await reader.for_speech() == []


@pytest.mark.asyncio
async def test_failing_authority_check_has_no_cached_fallback():
    async def load():
        return [{"eligibilityRevision": "original"}]

    async def check():
        raise TimeoutError("synthetic unavailable authority")

    reader = TurnKnowledgeReader(load, check)
    await reader.begin_turn()
    with pytest.raises(TimeoutError):
        await reader.for_speech()


@pytest.mark.asyncio
async def test_old_context_read_cannot_overwrite_new_turn():
    started, release = asyncio.Event(), asyncio.Event()
    count = 0

    async def load():
        nonlocal count
        count += 1
        value = count
        if value == 1:
            started.set()
            await release.wait()
        return [{"eligibilityRevision": str(value)}]

    async def check():
        return ["2"]

    reader = TurnKnowledgeReader(load, check)
    old = asyncio.create_task(reader.begin_turn())
    await started.wait()
    await reader.begin_turn()
    release.set()
    assert await old == []
    assert await reader.for_speech() == [{"eligibilityRevision": "2"}]


@pytest.mark.asyncio
async def test_legacy_adapter_and_separate_calls_do_not_share_cache():
    counts = {"one": 0, "two": 0}

    async def one():
        counts["one"] += 1
        return [{"tenantId": "one"}]

    async def two():
        counts["two"] += 1
        return [{"tenantId": "two"}]

    first, second = TurnKnowledgeReader(one), TurnKnowledgeReader(two)
    await first.begin_turn()
    await second.begin_turn()
    assert await first.for_speech() == [{"tenantId": "one"}]
    assert await second.for_speech() == [{"tenantId": "two"}]
    assert counts == {"one": 2, "two": 2}


@pytest.mark.asyncio
async def test_legacy_speech_load_finishing_after_new_turn_is_discarded():
    started, release = asyncio.Event(), asyncio.Event()
    loads = 0

    async def load():
        nonlocal loads
        loads += 1
        current = loads
        if current == 2:
            started.set()
            await release.wait()
        return [{"value": current}]

    reader = TurnKnowledgeReader(load)
    await reader.begin_turn()
    old = asyncio.create_task(reader.for_speech())
    await started.wait()
    await reader.begin_turn()
    release.set()
    assert await old == []


@pytest.mark.asyncio
async def test_revoked_snapshot_is_reloaded_after_authority_restoration():
    records = [{"eligibilityRevision": "original", "facts": ["first"]}]
    signature = ["original"]

    async def load():
        return deepcopy(records)

    async def check():
        return signature

    reader = TurnKnowledgeReader(load, check)
    await reader.begin_turn()
    signature.clear()
    assert await reader.for_speech() == []
    signature.append("original")
    records[0]["facts"] = ["fresh"]
    assert await reader.for_speech() == records


@pytest.mark.asyncio
async def test_interleaved_calls_revocation_and_new_turn_discard_only_stale_tenant_output():
    """A blocked authorization read cannot cross calls or survive a new turn."""
    started, release = asyncio.Event(), asyncio.Event()
    revisions = {"a": ["a/doc/1"], "b": ["b/doc/1"]}
    blocked = True

    async def load_a():
        return [{"tenantId": "a", "eligibilityRevision": "a/doc/1", "facts": ["a-only"]}]

    async def check_a():
        nonlocal blocked
        if blocked:
            blocked = False
            started.set()
            await release.wait()
        return list(revisions["a"])

    async def load_b():
        return [{"tenantId": "b", "eligibilityRevision": "b/doc/1", "facts": ["b-only"]}]

    async def check_b():
        return list(revisions["b"])

    a, b = TurnKnowledgeReader(load_a, check_a), TurnKnowledgeReader(load_b, check_b)
    await asyncio.gather(a.begin_turn(), b.begin_turn())
    old_a = asyncio.create_task(a.for_speech())
    await started.wait()
    assert (await b.for_speech())[0]["facts"] == ["b-only"]
    # A new caller turn supersedes the old pending speech lookup; revocation
    # independently removes its eligibility. Neither affects tenant B.
    await a.begin_turn()
    revisions["a"].clear()
    release.set()
    assert await old_a == []
    assert await a.for_speech() == []
    assert (await b.for_speech())[0]["tenantId"] == "b"
    revisions["a"].append("a/doc/1")
    assert (await a.for_speech())[0]["facts"] == ["a-only"]
