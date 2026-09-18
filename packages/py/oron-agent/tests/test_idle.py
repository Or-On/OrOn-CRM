"""Idle-caller prompting: nudge a silent caller, then end the call."""

import asyncio

from oron_agent.idle import IdlePolicy, UserIdlePoker
from oron_agent.language import language_profile
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    EndWorkerFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.idle_frame_processor import IdleFrameProcessor

PROMPTS = ["still there?", "anyone?", "goodbye then."]


def _poker() -> UserIdlePoker:
    """A poker whose pushed frames are captured instead of sent downstream."""
    poker = UserIdlePoker(prompts=PROMPTS, timeout_secs=15.0)
    poker.arm()  # these exercise a call in progress, not an empty room
    pushed: list = []

    sent: list = []

    async def capture(frame, direction=FrameDirection.DOWNSTREAM):
        pushed.append(frame)
        sent.append((frame, direction))

    poker.push_frame = capture  # type: ignore[method-assign]
    poker.pushed = pushed  # type: ignore[attr-defined]
    poker.sent = sent  # type: ignore[attr-defined]
    return poker


# --- the policy: the whole decision, no pipecat involved --------------------


def test_each_interval_yields_the_next_prompt_then_a_hangup():
    policy = IdlePolicy(prompts=PROMPTS)
    assert [policy.next_action() for _ in PROMPTS] == PROMPTS
    assert policy.next_action() is None  # None == end the call


def test_caller_speech_resets_the_allowance():
    """Someone who answers a nudge and later goes quiet again gets the full set
    again, rather than being hung up on the next silence."""
    policy = IdlePolicy(prompts=PROMPTS)
    policy.next_action()
    policy.next_action()

    policy.caller_spoke()

    assert policy.next_action() == PROMPTS[0]


# --- the processor: does it speak/hang up, and reset on the right frame? ----


async def test_each_idle_interval_speaks_the_next_prompt():
    poker = _poker()
    for _ in range(len(PROMPTS)):
        await poker._on_idle(poker)
    assert [f.text for f in poker.pushed if isinstance(f, TTSSpeakFrame)] == PROMPTS


async def test_the_call_ends_one_interval_after_the_sign_off():
    """The sign-off must be heard before the hangup, not truncated by it."""
    poker = _poker()
    for _ in range(len(PROMPTS)):
        await poker._on_idle(poker)
    assert not any(isinstance(f, EndWorkerFrame) for f in poker.pushed)

    await poker._on_idle(poker)
    assert isinstance(poker.pushed[-1], EndWorkerFrame)


async def test_the_hangup_reaches_the_worker_so_teardown_actually_runs():
    """A bare EndFrame pushed downstream stops the processors below the poker but
    never reaches the pipeline worker, so `on_pipeline_finished` — which
    finalizes the session row AND deletes the room — never fires. The caller is
    then left holding an open SIP leg with dead air."""
    poker = _poker()
    for _ in range(len(PROMPTS) + 1):
        await poker._on_idle(poker)

    frame, direction = poker.sent[-1]
    assert isinstance(frame, EndWorkerFrame)
    assert direction is FrameDirection.UPSTREAM


async def test_only_caller_speech_resets_it_not_the_bot_finishing_a_turn(monkeypatch):
    """A bot turn resets pipecat's TIMER (so we never nudge mid-answer) but must
    not restore the allowance — otherwise a silent caller is never hung up on."""

    # Bypass pipecat's base process_frame: it needs a live TaskManager. What is
    # under test is our override's reset rule, not pipecat's timer.
    async def noop(self, frame, direction):
        return None

    monkeypatch.setattr(IdleFrameProcessor, "process_frame", noop, raising=True)

    poker = _poker()
    poker.policy.next_action()

    await poker.process_frame(BotStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    assert poker.policy.pokes == 1, "a bot turn must not restore the allowance"

    await poker.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    assert poker.policy.pokes == 0, "caller speech must restore it"


def test_both_languages_ship_prompts_ending_in_a_signoff():
    for code in ("he", "en"):
        prompts = language_profile(code).idle_prompts
        assert len(prompts) >= 2, f"{code} needs at least a nudge and a sign-off"
        assert all(p.strip() for p in prompts)


async def test_the_agent_never_nudges_the_caller_mid_sentence(monkeypatch):
    """Heard live 2026-07-26: bot started speaking 02:29:04, asked "are you still
    there?" at 02:29:13, finished its own sentence at 02:29:14. The countdown
    from the END of the previous turn ran straight through this one."""

    # Same bypass as above: pipecat's base needs a live TaskManager, and what is
    # under test is our own tracking of the frames it already delivers.
    async def noop(self, frame, direction):
        return None

    monkeypatch.setattr(IdleFrameProcessor, "process_frame", noop, raising=True)

    poker = UserIdlePoker(prompts=["still there?", "hello?", "goodbye"], timeout_secs=0.01)
    poker.arm()
    await poker.process_frame(BotStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    spoken = []

    async def _push(frame, direction=None):
        spoken.append(frame)

    poker.push_frame = _push

    await poker._on_idle(poker)

    assert spoken == [], "nudged the caller while the agent was still talking"
    assert poker.policy.pokes == 0, "spent one of the caller's chances on our own speech"


async def test_the_agent_never_nudges_while_the_caller_is_still_speaking(monkeypatch):
    """A long caller utterance may exceed the idle interval; it is not silence."""

    async def noop(self, frame, direction):
        return None

    monkeypatch.setattr(IdleFrameProcessor, "process_frame", noop, raising=True)
    poker = UserIdlePoker(prompts=["still there?"], timeout_secs=0.01)
    poker.arm()
    spoken = await _push_into(poker)

    await poker.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    await poker._on_idle(poker)

    assert spoken == []
    assert poker.policy.pokes == 0

    await poker.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    await poker._on_idle(poker)
    assert [frame.text for frame in spoken] == ["still there?"]


async def test_dropped_turn_clears_active_user_state_without_refilling_allowance(monkeypatch):
    async def noop(self, frame, direction):
        return None

    monkeypatch.setattr(IdleFrameProcessor, "process_frame", noop, raising=True)
    poker = UserIdlePoker(prompts=PROMPTS, timeout_secs=0.01)
    poker.arm()
    await poker.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    poker.policy.next_action()
    poker._idle_event = asyncio.Event()

    poker.abandon_user_turn()

    assert poker._user_speaking is False
    assert poker.policy.pokes == 1
    assert poker._idle_event.is_set()


async def test_a_genuinely_silent_caller_is_still_nudged():
    """The guard must not disable the feature it protects."""
    poker = UserIdlePoker(prompts=["still there?"], timeout_secs=0.01)
    poker.arm()
    spoken = []

    async def _push(frame, direction=None):
        spoken.append(frame)

    poker.push_frame = _push

    await poker._on_idle(poker)

    assert [f.text for f in spoken] == ["still there?"]


async def _push_into(poker) -> list:
    spoken: list = []

    async def _push(frame, direction=None):
        spoken.append(frame)

    poker.push_frame = _push
    return spoken


async def test_an_empty_room_is_never_prompted_or_hung_up_on():
    """The pipeline starts when the BOT joins. Outbound that is before the phone
    rings — unarmed, the agent prompts nobody and ends the call while the callee
    is still hearing a ring tone. Seen 2026-07-26: three prompts and a hangup at
    ~48s, before the human had joined at all."""
    poker = UserIdlePoker(prompts=["a", "b"], timeout_secs=0.01)
    spoken = await _push_into(poker)

    for _ in range(5):
        await poker._on_idle(poker)

    assert spoken == []
    assert poker.policy.pokes == 0


async def test_the_call_is_ended_once_not_every_interval():
    """pipecat's idle loop re-arms after each timeout, so an exhausted policy
    pushed a fresh end frame every interval, forever."""
    poker = UserIdlePoker(prompts=["only one"], timeout_secs=0.01)
    poker.arm()
    spoken = await _push_into(poker)

    for _ in range(4):
        await poker._on_idle(poker)

    assert sum(isinstance(f, EndWorkerFrame) for f in spoken) == 1


async def test_pickup_restarts_the_countdown_rather_than_inheriting_the_ring():
    """Measured live 2026-08-04 on an outbound call to a real handset.

    pipecat's idle loop starts on StartFrame — when the bot joins the room,
    which on an outbound call is before the phone has even rung — and after
    every timeout it re-waits a full interval without resetting. Through 49
    seconds of ringing it therefore fired at ~15s intervals, silently, because
    `_armed` was still False.

    The caller answered at 07:06:58.1. The next deadline was already scheduled
    for 07:06:59.6, so arming inherited **1.5 seconds** of a 15-second window:
    prompt 1/3 was spoken at 07:06:59.6, and the bot's own greeting did not
    start producing audio until 07:07:00.6. The caller was asked whether they
    were still there before the agent had said anything at all.

    Setting the event is what restarts it: the loop's `wait_for` returns, clears
    the event, and waits a fresh full interval from pickup.
    """
    poker = UserIdlePoker(prompts=PROMPTS, timeout_secs=15.0)
    # What StartFrame would have created while the phone was ringing.
    poker._idle_event = asyncio.Event()
    assert not poker._idle_event.is_set(), "the ring leaves the loop mid-wait"

    poker.arm()

    assert poker._idle_event.is_set(), (
        "pickup must restart the countdown, or the caller's first silence is "
        "whatever was left of a window that began before the phone rang"
    )


async def test_rearm_restarts_the_countdown_without_restoring_the_allowance():
    """A turn VAD opened that no transcript closed is not evidence anyone spoke.

    The caller must not wait a second full interval for a turn nobody heard, but
    treating the drop as an answer would let a line that is silent apart from
    breathing hold the call open forever — each breath refilling the allowance.
    """
    poker = UserIdlePoker(prompts=PROMPTS, timeout_secs=15.0)
    poker.arm()
    poker.policy.next_action()
    poker.policy.next_action()
    poker._idle_event = asyncio.Event()

    poker.rearm()

    assert poker._idle_event.is_set(), "a dropped turn must restart the countdown"
    assert poker.policy.pokes == 2, "a dropped turn must not restore the allowance"


async def test_the_aggregator_still_announces_a_dropped_turn():
    """`bot.py` hangs the re-arm off pipecat's `on_user_turn_stop_timeout`.

    That event is the ONLY signal a turn was force-closed without inference —
    pipecat ends the turn and never triggers the LLM, so a rename upstream would
    silently restore the 2026-08-04 behaviour where a caller's turn vanished with
    nothing logged. Asserted against the real aggregator, not a stub.
    """
    aggregator = LLMContextAggregatorPair(LLMContext()).user()
    # `event_handler` accepts ANY string without complaint, so a rename upstream
    # leaves bot.py subscribed to a dead name and nothing anywhere says so.
    assert "on_user_turn_stop_timeout" in aggregator._event_handlers

    poker = UserIdlePoker(prompts=PROMPTS, timeout_secs=7.0)
    poker.arm()
    poker.policy.next_action()
    poker._idle_event = asyncio.Event()

    @aggregator.event_handler("on_user_turn_stop_timeout")
    async def _(_aggregator):
        poker.abandon_user_turn()

    await aggregator._on_user_turn_stop_timeout(None)
    # The handler is dispatched as its own task, so asserting straight after the
    # await passes on an empty event no matter what the handler does.
    await asyncio.sleep(0)

    assert poker._idle_event.is_set()
    assert poker.policy.pokes == 1


async def test_nudges_follow_a_mid_call_language_switch():
    from oron_agent.language import language_profile

    current = {"language": "he"}
    poker = UserIdlePoker(
        prompts=language_profile("he").idle_prompts,
        timeout_secs=15.0,
        prompts_for_current_language=lambda: language_profile(current["language"]).idle_prompts,
    )
    spoken = []

    async def capture(frame, _direction=None):
        spoken.append(getattr(frame, "text", None))

    poker.push_frame = capture  # type: ignore[method-assign]
    poker.arm()
    await poker._on_idle(poker)
    current["language"] = "en"
    await poker._on_idle(poker)

    assert spoken == [
        language_profile("he").idle_prompts[0],
        language_profile("en").idle_prompts[1],
    ]


def test_hebrew_sign_off_does_not_assume_the_persona_gender():
    from oron_agent.language import language_profile

    for prompt in language_profile("he").idle_prompts:
        assert "מסיים" not in prompt and "מסיימת" not in prompt
