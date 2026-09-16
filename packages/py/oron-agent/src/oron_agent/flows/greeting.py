from pipecat.flows import NodeConfig


def create_greeting_node(language: str = "en") -> NodeConfig:
    """Create one model-authored opener policy without localized response tables."""

    return NodeConfig(
        task_messages=[
            {
                "role": "system",
                "content": (
                    "OPENING TURN ONLY. Give one short, natural live-call greeting in "
                    f"the configured speech language code '{language}'. If the existing "
                    "conversation context supplies a business or support name, use it once; "
                    "otherwise say support without inventing a name. Ask how you can help. "
                    "Do not classify the caller, invoke a tool, or claim an action. After the "
                    "greeting, wait for the caller's first complete turn and treat it as a "
                    "normal user message."
                ),
            }
        ],
        respond_immediately=True,
    )
