from oron_agent.flows import create_greeting_node


def test_greeting_node_shape():
    node = create_greeting_node()
    assert "task_messages" in node
    assert node.get("pre_actions", []) == []
    assert "OPENING TURN ONLY" in node["task_messages"][0]["content"]
    assert "configured speech language code 'en'" in node["task_messages"][0]["content"]
    assert node["respond_immediately"] is True
