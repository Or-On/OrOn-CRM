"""The components the walking skeleton needs."""

from enum import StrEnum

from oron_common import E164
from pydantic import BaseModel, ConfigDict, Field, model_validator

from oron_flows.components._spec import ExitRequires, ExpandContext, register_component
from oron_flows.components._step import Step, step_field
from oron_flows.node import (
    ActionSpec,
    ActionType,
    FlowNode,
    FunctionSpec,
    Message,
    ParameterSpec,
    PropertyType,
)
from oron_flows.text import render_instruction

REPAIR_SUFFIX = "__repair"


class Collect(BaseModel):
    """One value the node must come away with.

    `describe` instructs the model, so it is English; `reask` is spoken aloud, so
    it is in the flow's language — the same split as `task` vs `say`.
    """

    model_config = ConfigDict(extra="forbid")
    name: str
    describe: str = Field(min_length=1)
    """What to extract, in English. Becomes the parameter's description."""
    required: bool = True
    """Required to the GATE, deliberately not to the JSON schema — see
    `converse_collect`. A caller who dodges the question must be re-asked, not
    have an answer invented for them."""
    reask: str | None = None
    """Spoken verbatim when this field is missing. Authored rather than
    generated: the repair turn is exactly where a call starts sounding robotic,
    and natural Hebrew is a product goal, not a polish item."""

    @model_validator(mode="after")
    def _required_fields_need_a_reask(self) -> Collect:
        if self.required and not self.reask:
            raise ValueError(
                f"collect '{self.name}' is required, so it needs a `reask` — the line "
                "spoken when the customer has not given it. Generating one would put "
                "machine-assembled wording in the caller's ear."
            )
        return self


def _node(
    step: Step,
    ctx: ExpandContext,
    *,
    instruction: str,
    speak: str | None,
    exit_: str | None,
    fn_suffix: str = "",
    exit_description: str = "function_description",
    respond_immediately: bool | None,
    **fields: str,
) -> list[FlowNode]:
    """The shape all three components share: an optional spoken opener, one task
    message, and either a single goto exit or a terminal end_conversation."""
    fn_name = f"{step.id}_{fn_suffix}" if exit_ else ""
    return [
        FlowNode(
            name=step.id,
            pre_actions=[ActionSpec(type=ActionType.tts_say, text=speak)] if speak else [],
            respond_immediately=respond_immediately,
            task_messages=[
                Message(
                    content=render_instruction(
                        ctx.instructions[instruction], function=fn_name, **fields
                    )
                )
            ],
            functions=[
                FunctionSpec(
                    name=fn_name,
                    description=ctx.instructions[exit_description],
                    parameters=[],
                    handler="goto",
                    config={"route": exit_},
                    routes={exit_: ctx.exits[exit_]},
                )
            ]
            if exit_
            else [],
            post_actions=[] if exit_ else [ActionSpec(type=ActionType.end_conversation)],
        )
    ]


class InformExit(StrEnum):
    acknowledged = "acknowledged"


class Inform(Step):
    use: str = "inform"
    say: str = step_field(..., description="What to tell the customer, spoken verbatim.")


def _expand_inform(step: Inform, ctx: ExpandContext) -> list[FlowNode]:
    return _node(
        step,
        ctx,
        instruction="inform",
        speak=step.say,
        exit_=InformExit.acknowledged,
        fn_suffix="answer",
        respond_immediately=False,
        say=step.say,
    )


register_component(
    model=Inform,
    description=(
        "Tell the customer something and wait for them to acknowledge before "
        "continuing. There is nothing to extract."
    ),
    exits=list(InformExit),
    default_exit=InformExit.acknowledged,
    exit_descriptions={"acknowledged": "The customer acknowledged."},
    expand=_expand_inform,
    examples=[
        {
            "id": "safety_notice",
            "use": "inform",
            "say": "Please keep the area clear before the visit. Is that clear?",
        }
    ],
)


class Announce(Step):
    use: str = "announce"
    say: str | None = step_field(
        None,
        description=(
            "Spoken verbatim before the model's closing turn. Supports "
            "${session_var} interpolation, so a factual summary is "
            "deterministic rather than recalled by the model."
        ),
    )
    then: str = step_field("", description="What the model should say to close, in English.")


def _expand_announce(step: Announce, ctx: ExpandContext) -> list[FlowNode]:
    # respond_immediately stays unset: False defers post_actions, and a deferred
    # end_conversation can be dropped while a tts_say is still in flight. So the
    # model DOES take a turn here, which is why `then` must never render empty.
    # An empty system prompt is not silence, it is a free hand: heard live on
    # 2026-07-26, one authored goodbye was followed by two model-invented ones.
    return _node(
        step,
        ctx,
        instruction="announce" if step.then else "announce_already_said",
        speak=step.say,
        exit_=None,
        respond_immediately=None,
        then=step.then,
    )


register_component(
    model=Announce,
    description="End the call: read back a deterministic summary, then let the model close.",
    exits=[],
    expand=_expand_announce,
    examples=[
        {
            "id": "done",
            "use": "announce",
            "say": "To summarise ${customer_name}, you are booked for ${slot_display}.",
            "then": "Thank them, wish them a good day, and say goodbye.",
        }
    ],
)


class Transfer(Step):
    """Hand the call to a human and leave. Terminal, like Announce — but the line
    ends with a SIP REFER instead of a hangup."""

    use: str = "transfer"
    say: str = step_field(
        ...,
        description=(
            "Spoken verbatim before the handover, in the flow's language. Required: "
            "a caller moved to a ringing phone with no warning thinks they were cut off."
        ),
    )
    to: E164 = step_field(
        ...,
        description=(
            "The human's number in E.164 (+972...). Validated at publish, because the "
            "alternative is a caller discovering it."
        ),
    )


def _expand_transfer(step: Transfer, ctx: ExpandContext) -> list[FlowNode]:
    # ONE post_actions list, tts_say first — pipecat only blocks a custom action
    # behind a tts_say in the same list, and respond_immediately=False would defer
    # the pair onto a frame this node never emits.
    return [
        FlowNode(
            name=step.id,
            task_messages=[Message(content=ctx.instructions["transfer"])],
            post_actions=[
                ActionSpec(type=ActionType.tts_say, text=step.say),
                ActionSpec(type=ActionType.transfer, to=step.to),
            ],
        )
    ]


register_component(
    model=Transfer,
    description=(
        "Hand the call to a human on another phone and end the agent's part. The "
        "caller hears one authored line, then the carrier moves the leg; whatever "
        "that number does with the call is its own business. Terminal — nothing "
        "runs after it and the conversation does not come back."
    ),
    exits=[],
    expand=_expand_transfer,
    examples=[
        {
            "id": "to_human",
            "use": "transfer",
            "say": "I am putting you through to a colleague now, one moment.",
            "to": "+14155552671",
        }
    ],
)


class ConverseExit(StrEnum):
    done = "done"
    exhausted = "exhausted"


class CollectRoute(StrEnum):
    """A route the gate returns that is NOT an author-facing exit: retry is
    internal wiring to the repair sibling, not a place a flow can route to."""

    retry = "retry"


class Converse(Step):
    """A free-form model turn. The generic fallback when no specialised
    component matches the author's intent."""

    use: str = "converse"
    task: str = step_field(
        ..., description="What the model should accomplish in this turn, in English."
    )
    say: str | None = step_field(
        None,
        description=(
            "Optional opening line, spoken verbatim before the model's turn. "
            "Set it when the wording must be exact; leave it out to let the "
            "model open."
        ),
    )
    collect: list[Collect] = step_field(
        default_factory=list,
        description=(
            "Values this turn must come away with. Each becomes a function "
            "parameter; a missing required one re-asks with its authored line "
            "instead of letting the flow move on incomplete."
        ),
    )
    max_attempts: int = step_field(
        3,
        description=(
            "How many times the customer may fail to supply a required value "
            "before the `exhausted` exit is taken."
        ),
    )


def _expand_converse(step: Converse, ctx: ExpandContext) -> list[FlowNode]:
    fn_name = f"{step.id}_done"
    required = [c for c in step.collect if c.required]

    # The gate returns `exhausted` only after a REQUIRED value has gone
    # unanswered max_attempts times. Its `required` list is what makes that
    # possible, so with none the exit can never fire — whether the step collects
    # nothing at all, or only optional values.
    #
    # Both were silent in their own way. With nothing collected the route was
    # dropped, and the flow was refused for an "unreachable node" naming the
    # target rather than this step. With only optional values the route was kept
    # and the flow SAVED — and the node behind it simply never ran.
    if ConverseExit.exhausted in ctx.exits and not required:
        raise ValueError(
            f"step '{step.id}' routes its 'exhausted' exit to "
            f"'{ctx.exits[ConverseExit.exhausted]}', but collects no required "
            "value. That exit is taken only when the customer fails to supply a "
            "required one within max_attempts, so nothing would ever reach that "
            "node. Mark a collected value required, or remove the route."
        )

    if not step.collect:
        # An authored opener is spoken by TTS, so the model must not also speak on
        # entry; with no opener it is the only speaker and must run immediately.
        return _node(
            step,
            ctx,
            instruction="converse",
            speak=step.say,
            exit_=ConverseExit.done,
            fn_suffix="done",
            # NOT the generic function_description: that one says "when the customer
            # responds", which makes a conversational node exit on the first reply.
            exit_description="converse_exit_description",
            respond_immediately=not step.say,
            task=step.task,
        )

    if required and ConverseExit.exhausted not in ctx.exits:
        raise ValueError(
            f"step '{step.id}' collects required value(s) "
            f"{[c.name for c in required]}, so it can run out of attempts — "
            "route its 'exhausted' exit in `on:`. Giving up on a caller is a "
            "routing decision, never inherited from the order of the file."
        )

    repair_name = f"{step.id}{REPAIR_SUFFIX}"
    reask_var = f"{step.id}_reask"
    fields = "; ".join(c.describe for c in step.collect)
    parameters = [
        # required=False even for a required field: the gate enforces presence,
        # the schema must not, or the model fabricates rather than admitting the
        # customer dodged. See `converse_collect`.
        ParameterSpec(name=c.name, type=PropertyType.string, description=c.describe, required=False)
        for c in step.collect
    ]
    config = {
        "required": [c.name for c in required],
        "reasks": {c.name: c.reask for c in required},
        # Namespaced so two collecting steps never share a counter (PR2's
        # convention for `CollectAndLookup`).
        "attempts_var": f"{step.id}_attempts",
        "reask_var": reask_var,
        "max_attempts": step.max_attempts,
    }
    # Annotated: the keys mix two StrEnums, and dict[CollectRoute | ConverseExit, str]
    # is not a Mapping[str, ...] to the type checker even though both are strs.
    routes: dict[str, str] = {
        ConverseExit.done: ctx.exits[ConverseExit.done],
        CollectRoute.retry: repair_name,
        # Unroutable when nothing is required — the gate can never return it.
        ConverseExit.exhausted: ctx.exits.get(ConverseExit.exhausted, repair_name),
    }

    # One spec, shared by the ask node and its repair sibling: nothing mutates a
    # FunctionSpec after expand, and both nodes advertise exactly the same exit.
    collect_fn = FunctionSpec(
        name=fn_name,
        description=ctx.instructions["converse_exit_description"],
        parameters=parameters,
        handler="collect_gate",
        config=config,
        routes=routes,
    )

    def _collecting_node(
        name: str, speak: str | None, instruction: str, **fields_: str
    ) -> FlowNode:
        """Both nodes are the same shape: speak (or not), one rendered task
        message, the one collect function. Only the wording differs."""
        return FlowNode(
            name=name,
            pre_actions=[ActionSpec(type=ActionType.tts_say, text=speak)] if speak else [],
            respond_immediately=not speak,
            task_messages=[
                Message(
                    content=render_instruction(
                        ctx.instructions[instruction], function=fn_name, **fields_
                    )
                )
            ],
            functions=[collect_fn],
        )

    return [
        _collecting_node(step.id, step.say, "converse_collect", task=step.task, fields=fields),
        # A SIBLING, not a jump back to `step.id`: pre_actions live on the node,
        # so routing retry to itself replays the authored opener at someone who
        # already heard it. The repair node speaks only the reask the gate
        # selected for the fields actually missing.
        _collecting_node(repair_name, f"${{{reask_var}}}", "collect_repair", fields=fields),
    ]


register_component(
    model=Converse,
    description=(
        "Have a free-form exchange with the customer to accomplish one stated "
        "objective, then continue. Use when no more specific component fits."
    ),
    exits=list(ConverseExit),
    default_exit=ConverseExit.done,
    optional_exits=[ConverseExit.exhausted],
    # A step runs out of attempts only on a value it *requires*; a list of
    # purely optional ones reaches this exit exactly as never as an empty list
    # does. Without the flag an editor offers a port that expands to a route
    # nothing ever takes, and the node behind it is dead while the flow saves.
    exit_requires={ConverseExit.exhausted: ExitRequires(property="collect", flag="required")},
    exit_descriptions={
        "done": "The objective was accomplished.",
        "exhausted": (
            "The customer did not supply a required value within max_attempts. "
            "Only reachable when the step collects something required."
        ),
    },
    expand=_expand_converse,
    examples=[
        {
            "id": "collect_reason",
            "use": "converse",
            "task": "Find out briefly why the caller is contacting us, and confirm you understood.",
        },
        {
            "id": "ask_size",
            "use": "converse",
            "task": "Ask what size they need and confirm it back.",
            "collect": [
                {
                    "name": "size",
                    "describe": "The size the customer asked for.",
                    "reask": "Sorry, which size was it?",
                }
            ],
            "on": {"exhausted": "handover"},
        },
    ],
)


class Choice(BaseModel):
    """One outcome of a branch: when it applies, and where the call goes."""

    model_config = ConfigDict(extra="forbid")
    describe: str = Field(min_length=1)
    """When this outcome applies, in English — what the model matches on."""
    to: str = Field(min_length=1)
    """Target node name. FlowSpec rejects one that does not exist."""


class Branch(Step):
    """Route the call on what the customer said.

    Targets live in `choices`, not `on:`. The outcomes are authored data, so the
    registry cannot enumerate them as exits at registration time — and declaring
    none keeps the unknown-exit guard meaningful: an `on:` key on a branch is
    rejected rather than silently ignored.
    """

    use: str = "branch"
    ask: str = step_field(..., description="What the model must determine, in English.")
    say: str | None = step_field(
        None,
        description=(
            "Optional line spoken verbatim before the model's turn. Set it when "
            "the question must be worded exactly; leave it out when the branch "
            "reads an answer the customer has already given."
        ),
    )
    choices: dict[str, Choice] = step_field(
        ..., description="Outcome name -> when it applies and which node it goes to."
    )
    sets: str | None = step_field(
        None, description="Session variable to record the chosen outcome in."
    )

    @model_validator(mode="after")
    def _a_branch_needs_somewhere_to_diverge(self) -> Branch:
        if len(self.choices) < 2:
            raise ValueError(
                f"branch '{self.id}' declares {len(self.choices)} choice(s); a single "
                "outcome is a converse step, not a branch"
            )
        return self


def _expand_branch(step: Branch, ctx: ExpandContext) -> list[FlowNode]:
    fn_name = f"{step.id}_choose"
    config: dict = {"arg": "choice", "on": {name: name for name in step.choices}}
    if step.sets:
        config["sets"] = step.sets
    return [
        FlowNode(
            name=step.id,
            pre_actions=([ActionSpec(type=ActionType.tts_say, text=step.say)] if step.say else []),
            respond_immediately=not step.say,
            task_messages=[
                Message(
                    content=render_instruction(
                        ctx.instructions["branch"],
                        ask=step.ask,
                        options="\n".join(
                            f"- {name}: {c.describe}" for name, c in step.choices.items()
                        ),
                        function=fn_name,
                    )
                )
            ],
            functions=[
                FunctionSpec(
                    name=fn_name,
                    description=ctx.instructions["function_description"],
                    parameters=[
                        # Required here, unlike a collected value. `Collect` asks
                        # for a FACT the customer may never have given, so forcing
                        # it invites invention; a branch asks for the model's own
                        # classification, which it can always produce.
                        ParameterSpec(
                            name="choice",
                            type=PropertyType.string,
                            description=(
                                "Which outcome applies, judged from what the customer said."
                            ),
                            enum=list(step.choices),
                            required=True,
                        )
                    ],
                    handler="route_by",
                    config=config,
                    # `error` is unreachable while `choice` is a required enum, but
                    # the binder raises on an unmapped route, so map it rather than
                    # crash mid-call if route_by's contract ever changes.
                    routes={name: c.to for name, c in step.choices.items()} | {"error": step.id},
                )
            ],
        )
    ]


register_component(
    model=Branch,
    description=(
        "Route the call on what the customer said — a yes/no gate, a three-way "
        "close, which objection was raised. The outcomes and where each one goes "
        "are authored data, so this component declares no exits of its own."
    ),
    exits=[],
    expand=_expand_branch,
    examples=[
        {
            "id": "has_a_moment",
            "use": "branch",
            "say": "Do you have a moment?",
            "ask": "whether the customer agreed to continue the call now",
            "choices": {
                "yes": {"describe": "They agreed to talk.", "to": "pitch"},
                "no": {"describe": "They declined or asked not to be called.", "to": "sign_off"},
            },
            "sets": "consent",
        }
    ],
)
