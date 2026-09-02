from oron_agent.flows import create_greeting_node


def test_greeting_node_shape():
    node = create_greeting_node()
    assert "task_messages" in node
    assert any("עברית" in m["content"] or "היי" in m["content"] for m in node["task_messages"])
    assert node.get("respond_immediately", True) is True
