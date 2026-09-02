from pipecat.flows import NodeConfig


def create_greeting_node() -> NodeConfig:
    """Greeting: agent greets in Hebrew and invites the caller to talk.

    No Hebrew rule block: the broad style prompt measured worse than none, and
    caller gender is not known yet at node-build time — ECAPA appends it to the
    context (LLMMessagesAppendFrame) about a second into the call instead.
    """
    return NodeConfig(
        task_messages=[
            {
                "role": "system",
                # Instruction in English (the model follows instructions best
                # in English); the line it must SPEAK is quoted in Hebrew so the
                # exact wording is pinned.
                "content": (
                    "Open with this short Hebrew greeting, verbatim: "
                    "'היי, מדבר העוזר הקולי. איך אפשר לעזור?' "
                    "Then wait for the caller and continue the conversation naturally in Hebrew."
                ),
            }
        ],
        respond_immediately=True,
    )
