from oron_agent.flows import initial_node_from_composition
from oron_flows.seeds import EXAMPLE_HE_ID, composition_for


def test_a_bound_flow_id_binds_to_a_live_node():
    node = initial_node_from_composition(composition_for(EXAMPLE_HE_ID))
    # the greeting is authored verbatim via `say` (pre_actions), not an LLM task
    assert "שלום" in node["pre_actions"][0]["text"]
