from pipecat.flows import NodeConfig

OPENING_TURN_PREFIX = "OPENING TURN ONLY."


def create_greeting_node(language: str = "en", role_message: str | None = None) -> NodeConfig:
    """Create one model-authored opener policy without localized response tables.

    The instruction is turn-scoped: ``OpeningTurnContext`` retires it once an
    assistant turn exists, so it cannot keep asking for a greeting mid-call.
    """

    node = NodeConfig(
        task_messages=[
            {
                "role": "system",
                "content": (
                    f"{OPENING_TURN_PREFIX} Give one short, natural live-call greeting in "
                    f"the configured speech language code '{language}'. Identify yourself "
                    "with the trusted tenant support identity from your instructions, once; "
                    "if no organization name is configured, say support without inventing "
                    "one. Ask how you can help. If the caller has already spoken, greet "
                    "briefly and answer what they said. Do not classify the caller, invoke "
                    "a tool, or claim an action."
                ),
            }
        ],
        respond_immediately=True,
    )
    if role_message and role_message.strip():
        node["role_message"] = role_message.strip()
    return node
