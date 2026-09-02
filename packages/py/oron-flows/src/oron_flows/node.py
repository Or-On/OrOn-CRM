"""The stored node — a serializable, field-for-field mirror of pipecat's
``NodeConfig`` (``pipecat.flows.types.NodeConfig``), plus ``on_enter``.

``NodeConfig`` itself cannot be stored: its ``functions`` hold live
``FlowsFunctionSchema`` objects with bound Python callables, so it cannot be
persisted, frozen at publish, diffed across versions or rendered by an editor.
This module is that shape with handlers named by *registry key*;
``oron_agent.flows.binder`` resolves the keys back to callables.

Deliberately no pipecat import — ``oron-flows`` stays pure pydantic.
"""

from enum import StrEnum
from typing import Any

from oron_common import E164
from pydantic import BaseModel, Field, model_validator


class MessageRole(StrEnum):
    """Roles an LLM context message may carry."""

    system = "system"
    developer = "developer"
    user = "user"
    assistant = "assistant"


class ActionType(StrEnum):
    """Action ``type`` values we emit.

    ``tts_say`` and ``end_conversation`` are pipecat built-ins. ``delay`` and
    ``transfer`` are OURS — registered on the FlowManager in bot.py; ActionConfig
    passes unknown fields (``seconds``, ``to``) through to the handler.
    """

    tts_say = "tts_say"
    delay = "delay"
    end_conversation = "end_conversation"
    transfer = "transfer"


_TERMINAL_ACTIONS = frozenset({ActionType.end_conversation, ActionType.transfer})


class PropertyType(StrEnum):
    """JSON-schema types a function parameter may declare."""

    string = "string"
    boolean = "boolean"
    integer = "integer"
    number = "number"


class Message(BaseModel):
    role: MessageRole = MessageRole.system
    content: str


class ActionSpec(BaseModel):
    type: ActionType
    text: str | None = None
    seconds: float | None = None
    """Only meaningful for ``delay``."""
    to: E164 | None = None
    """Only meaningful for ``transfer`` — the human's number the leg is REFERed to."""

    @model_validator(mode="after")
    def _payload_matches_type(self) -> ActionSpec:
        if self.type is ActionType.tts_say and not self.text:
            raise ValueError("tts_say action requires 'text'")
        if self.type is ActionType.delay and self.seconds is None:
            raise ValueError("delay action requires 'seconds'")
        if self.type is ActionType.transfer and not self.to:
            raise ValueError("transfer action requires 'to'")
        return self


class ParameterSpec(BaseModel):
    """One parameter of an LLM function call.

    The author declares WHAT to extract; the binder turns this into the
    JSON-schema ``properties``/``required`` of a FlowsFunctionSchema. Nobody
    hand-writes a schema.
    """

    name: str
    type: PropertyType = PropertyType.string
    description: str = ""
    enum: list[str] | None = None
    required: bool = True


class EnterSpec(BaseModel):
    """A handler run when the node is entered, rather than when the model calls it.

    The binder awaits it between merging the previous handler's ``data`` and
    rendering the target node, so anything it writes to the session is spoken on
    that very entry. Its ``route`` is ignored — nothing chose to come here.
    """

    handler: str
    """Key into the agent's HandlerRegistry — the same registry LLM-called
    functions use. Entry and call are two triggers for one mechanism."""
    config: dict[str, Any] = Field(default_factory=dict)
    """Handler configuration, exactly as on ``FunctionSpec``."""


class FunctionSpec(BaseModel):
    name: str
    description: str
    parameters: list[ParameterSpec] = Field(default_factory=list)
    handler: str
    """Key into the agent's HandlerRegistry — never a callable."""
    config: dict[str, Any] = Field(default_factory=dict)
    """Handler configuration; what makes a handler generic. Each handler parses it
    with its own Pydantic model when called — validating at publish would need the
    handler registry, which oron-flows deliberately cannot see."""
    routes: dict[str, str] = Field(default_factory=dict)
    say_while: list[str] = Field(default_factory=list)
    """Spoken the moment this function is called, before its handler runs — for a
    handler that waits on something (a lookup), where the caller otherwise hears
    the tool call AND the wait as one silence.

    Authored per function, never generated and never generic: it has to name what
    is actually being done here ("רגע, בודקת את התאריכים"), in the flow's language
    and the persona's gender. A filler that would fit any node is the one that
    sounds like a bot.

    A LIST because these bypass the model, so the anti-repetition rule in the
    persona cannot reach them: one string is spoken verbatim every time the
    handler runs. Entries are used in turn. Empty — the default — says nothing,
    which is right for any handler that returns immediately."""


class FlowNode(BaseModel):
    """One pipecat node, serializable."""

    name: str
    task_messages: list[Message] = Field(default_factory=list)
    role_message: str | None = None
    """pipecat 1.5.0 replaced ``role_messages: list[dict]`` with this."""
    functions: list[FunctionSpec] = Field(default_factory=list)
    pre_actions: list[ActionSpec] = Field(default_factory=list)
    post_actions: list[ActionSpec] = Field(default_factory=list)
    on_enter: EnterSpec | None = None
    respond_immediately: bool | None = None

    @property
    def is_terminal(self) -> bool:
        """No LLM turn follows — which is also what keeps globals off the node."""
        return any(a.type in _TERMINAL_ACTIONS for a in self.post_actions)

    @model_validator(mode="after")
    def _unique_function_names(self) -> FlowNode:
        names = [f.name for f in self.functions]
        if len(names) != len(set(names)):
            raise ValueError(f"node '{self.name}' has duplicate function names")
        return self
