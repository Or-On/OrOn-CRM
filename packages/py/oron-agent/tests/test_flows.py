from oron_agent.flows import create_greeting_node


def test_greeting_node_shape():
    node = create_greeting_node()
    assert "task_messages" in node
    assert node["pre_actions"] == [{"type": "tts_say", "text": "שלום, כאן התמיכה. איך אפשר לעזור?"}]
    assert node["respond_immediately"] is False
