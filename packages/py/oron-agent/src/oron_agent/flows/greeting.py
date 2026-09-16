from pipecat.flows import NodeConfig


def create_greeting_node(language: str = "he") -> NodeConfig:
    """Deterministic greeting that never spends the first turn on the LLM.

    The first words of a call are a product contract, not a grounded-answer
    task. Running the model before the caller has spoken can make the evidence
    guard answer an imaginary question. Speak one short, gender-neutral line,
    then let the caller's real first turn enter the model context.
    """
    english = language.casefold().startswith("en")
    greeting = (
        "Hello, this is support. How can I help?"
        if english
        else "שלום, כאן התמיכה. איך אפשר לעזור?"
    )
    return NodeConfig(
        task_messages=[
            {
                "role": "system",
                "content": (
                    "The deterministic greeting has already been spoken. Wait for "
                    "the caller's first turn, respond to what they actually said, "
                    f"and continue naturally in {'English' if english else 'Hebrew'}."
                ),
            }
        ],
        pre_actions=[{"type": "tts_say", "text": greeting}],
        respond_immediately=False,
    )
