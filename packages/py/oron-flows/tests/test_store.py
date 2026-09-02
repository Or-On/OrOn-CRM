import json
import uuid

import pytest
from oron_flows.components.library.basic import Announce, Inform
from oron_flows.compose import Composition, FlowMeta, Persona
from oron_flows.store import FileFlowStore, PublishedFlow

FLOW_ID = uuid.uuid4()

COMPOSITION = Composition(
    flow=FlowMeta(id=FLOW_ID, version=3, language="he"),
    persona=Persona(agent_name="נועה", org="המוקד", gender="female"),
    steps=[Inform(id="a", say="שלום"), Announce(id="b", then="bye")],
)


async def test_publish_returns_the_authored_version(tmp_path):
    assert await FileFlowStore(tmp_path / "flow.json").publish("_global", COMPOSITION) == 3


async def test_publish_writes_source_spec_and_components_version(tmp_path):
    path = tmp_path / "flow.json"
    await FileFlowStore(path).publish("_global", COMPOSITION)
    published = PublishedFlow(**json.loads(path.read_text(encoding="utf-8")))
    assert published.source.flow.id == FLOW_ID
    assert published.spec.entry == "a"
    assert published.components_version


async def test_the_stored_source_rehydrates_into_typed_steps(tmp_path):
    path = tmp_path / "flow.json"
    await FileFlowStore(path).publish("_global", COMPOSITION)
    published = PublishedFlow(**json.loads(path.read_text(encoding="utf-8")))
    assert isinstance(published.source.steps[0], Inform)


async def test_load_returns_the_frozen_spec_not_a_re_expansion(tmp_path):
    """The point of freezing: editing a shared component must not change what a
    published flow does until it is deliberately republished."""
    path = tmp_path / "flow.json"
    store = FileFlowStore(path)
    await store.publish("_global", COMPOSITION)

    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["spec"]["nodes"][1]["task_messages"][0]["content"] = "EDITED IN PLACE"
    path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")

    spec = await store.load("_global", "t", 3)
    assert spec.node("b").task_messages[0].content == "EDITED IN PLACE"


async def test_list_versions_reports_the_published_version(tmp_path):
    store = FileFlowStore(tmp_path / "flow.json")
    await store.publish("_global", COMPOSITION)
    assert await store.list_versions("_global", "t") == [3]


async def test_publishing_an_unroutable_composition_fails_at_publish_time(tmp_path):
    bad = Composition(flow=FlowMeta(id=uuid.uuid4(), version=1), steps=[Inform(id="a", say="x")])
    with pytest.raises(ValueError, match="nowhere to fall through"):
        await FileFlowStore(tmp_path / "f.json").publish("_global", bad)
