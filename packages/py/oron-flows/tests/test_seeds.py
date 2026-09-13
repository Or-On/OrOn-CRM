"""The packaged catalog: what a DID's flow_id resolves to."""

import uuid

import pytest
from oron_flows.seeds import (
    EXAMPLE_EN,
    EXAMPLE_EN_ID,
    EXAMPLE_HE,
    EXAMPLE_HE_ID,
    SEED_COMPOSITIONS,
    composition_for,
)


def test_registry_is_keyed_by_the_flows_own_id():
    """`phone_numbers.flow_id` is looked up in this dict, so its keys must BE the
    ids. A key drifting from its composition's FlowMeta.id would make a DID
    answer with a different flow than the one it names."""
    assert all(flow_id == c.flow.id for flow_id, c in SEED_COMPOSITIONS.items())


def test_picks_the_composition_the_did_is_bound_to():
    assert composition_for(EXAMPLE_EN_ID) is EXAMPLE_EN
    assert composition_for(EXAMPLE_HE_ID) is EXAMPLE_HE


def test_unknown_fixture_id_never_substitutes_the_hebrew_example():
    with pytest.raises(KeyError):
        composition_for(uuid.uuid4())
