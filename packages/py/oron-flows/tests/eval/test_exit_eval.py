"""Does this flow still leave the conversation on the model you switched to?

`deploy.env.example` puts any OpenAI-compatible LLM one metadata key away, and
this flow navigates by TOOL CALLS. A model that mishandles them does not degrade
audibly — it keeps selling to someone who already said goodbye, which is what a
real caller heard on 2026-07-27.

Measured 2026-08-01 against the canvass `talk` node: on the pre-#65 wording
gemma-4-31b left on 6 of 12 goodbyes where gemini-2.5-flash left on 12 of 12, on
byte-identical text. The prompt contradicted itself and Gemini's instruction
hierarchy happened to resolve it the way we meant. "It works on Vertex" is
therefore not evidence about any other model, which is why this exists.

Opt-in — it costs money and needs a network. Configured by the same three
variables that select the model in production, so a passing run describes the
deployment rather than a bench rig:

    ORON_LLM_BASE_URL=https://api.cerebras.ai/v1 \
    ORON_LLM_MODEL=gemma-4-31b \
    LLM_API_KEY=... \
    uv run pytest packages/oron-flows/tests/eval -s

Unset any of them and it reports `unavailable` instead of passing quietly.
"""

from __future__ import annotations

import os
from collections import Counter

import httpx
import pytest
from oron_flows.compose import expand
from oron_flows.node import FlowNode
from oron_flows.seeds import CANVASS_HE
from pydantic import BaseModel

RUNS = 3

# A mid-call conversation, as the LLM would see it. Fourteen turns rather than a
# cold prompt: the exit is the LAST thing the model does, and a model that has
# already produced thirteen turns of Hebrew persuasion behaves differently from
# one answering its first message.
HISTORY: list[tuple[str, str]] = [
    (
        "assistant",
        "תודה. אז… רצינו לשתף אותך בכמה מחשבות על השר אלי כהן. "
        "אבל קודם — מה הכי חשוב לך שישתפר במדינה היום?",
    ),
    ("user", "יוקר המחיה. אי אפשר לחיות ככה."),
    (
        "assistant",
        "אני שומע אותך. השר כהן רואה חשבון מוסמך שניהל תקציבים גדולים שנים, "
        "אז הוא מבין את הכלכלה מבפנים. מה הכי מכביד עליך?",
    ),
    ("user", "הכל. אוכל, דיור, חשמל."),
    (
        "assistant",
        "מובן לגמרי. הוא כיום שר האנרגיה והתשתיות ומוביל שינוי במערך האנרגיה. "
        "מה היית רוצה לראות משתנה קודם?",
    ),
    ("user", "תשמע, כל הפוליטיקאים מבטיחים ולא עושים כלום."),
    (
        "assistant",
        "אני מבין את התסכול, והוא לגיטימי. אני מעדיף להצביע על מה שכבר נעשה — "
        "הרפורמות שלו חסכו למשק מיליארדים. זה משנה משהו בעיניך?",
    ),
    ("user", "אולי. אבל אני לא בטוח שהוא מבין אנשים כמוני."),
    (
        "assistant",
        "שאלה הוגנת. הוא מחולון, רב סרן במילואים, נשוי ואב לארבעה ילדים — "
        "חיים די רגילים. מה היה משכנע אותך שמישהו באמת מבין?",
    ),
    ("user", "שיבוא לגור פה חודש."),
    ("assistant", "זה הוגן, ובאמת קשה להתווכח עם זה. מה הכי היה משנה לך אם היה קורה?"),
    ("user", "שהמחירים ירדו."),
    (
        "assistant",
        "ברור. הוא שימש שר כלכלה, מודיעין, חוץ ועכשיו אנרגיה ותשתיות — "
        "תיקים שנוגעים ישירות לזה. יש עוד משהו שחשוב לך שאדע?",
    ),
]


def talk_node() -> FlowNode:
    """The real compiled node — never a copy of its prompt.

    A restated prompt would let this eval keep certifying wording that
    ``seeds.py`` no longer ships, which is the failure mode where a green
    harness blesses something that never ran.
    """
    return next(n for n in expand(CANVASS_HE).nodes if n.name == "talk")


def request(model: str, last_turn: str) -> dict:
    """An OpenAI-compatible chat request for `last_turn` arriving mid-call."""
    node = talk_node()
    messages = [{"role": m.role.value, "content": m.content} for m in node.task_messages]
    if node.role_message:
        messages.insert(0, {"role": "system", "content": node.role_message})
    messages += [{"role": role, "content": text} for role, text in HISTORY]
    messages.append({"role": "user", "content": last_turn})

    tools = [
        {
            "type": "function",
            "function": {
                "name": f.name,
                "description": f.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        p.name: {"type": p.type.value, "description": p.description}
                        for p in f.parameters
                    },
                    "required": [p.name for p in f.parameters if p.required],
                },
            },
        }
        for f in node.functions
    ]
    return {"model": model, "messages": messages, "tools": tools}


def exit_function_names() -> set[str]:
    """Every function on the node that leaves it, read off the routes.

    Hardcoding `talk_done` would have hidden the finding this harness exists to
    surface: `global_stop_calling` also leaves, to a different node.
    """
    return {f.name for f in talk_node().functions if f.routes}


class ExitCase(BaseModel):
    """One last caller turn, and which exit — if any — it should route to.

    `expect` is the point. Both exits end the node, so "did it leave" is passed
    by a model that sends a do-not-call request to the node that asks for a vote.
    """

    label: str
    last_turn: str
    expect: str | None


CASES = [
    # Not the same as a goodbye: this one must reach `respect`, and routing it to
    # `close` asks a voter for their vote right after they demanded to be left alone.
    ExitCase(
        label="explicit stop",
        last_turn="תפסיקו להתקשר אלי, תורידו אותי מהרשימה.",
        expect="global_stop_calling",
    ),
    ExitCase(label="firm goodbye", last_turn="ביי ביי, יום טוב.", expect="talk_done"),
    ExitCase(label="soft close", last_turn="לא, זהו. תודה.", expect="talk_done"),
    # The control. Without it "always exits" scores a perfect run, and ships a
    # bot that hangs up on engaged voters.
    ExitCase(
        label="still engaged",
        last_turn="רגע, מה הוא עשה בתחום האנרגיה?",
        expect=None,
    ),
]


class Endpoint(BaseModel):
    base_url: str
    model: str
    api_key: str


def _endpoint() -> Endpoint | None:
    values = {
        "base_url": os.environ.get("ORON_LLM_BASE_URL", ""),
        "model": os.environ.get("ORON_LLM_MODEL", ""),
        "api_key": os.environ.get("LLM_API_KEY", ""),
    }
    return Endpoint(**values) if all(values.values()) else None


def _called(client: httpx.Client, endpoint: Endpoint, case: ExitCase) -> str | None:
    """The function the model chose, or None when it answered in text."""
    response = client.post(
        f"{endpoint.base_url.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {endpoint.api_key}"},
        json=request(endpoint.model, case.last_turn),
        timeout=90.0,
    )
    response.raise_for_status()
    calls = response.json()["choices"][0]["message"].get("tool_calls") or []
    return calls[0]["function"]["name"] if calls else None


def test_the_flow_leaves_when_the_caller_is_done_and_not_before():
    endpoint = _endpoint()
    if endpoint is None:
        pytest.skip("unavailable — set ORON_LLM_BASE_URL, ORON_LLM_MODEL and LLM_API_KEY")

    exits = exit_function_names()
    print(f"\n[exit-eval] {endpoint.model} @ {endpoint.base_url} — exits: {sorted(exits)}")

    failures = []
    with httpx.Client() as client:
        for case in CASES:
            chosen = Counter(_called(client, endpoint, case) for _ in range(RUNS))
            left = sum(n for name, n in chosen.items() if name in exits)
            routed = chosen[case.expect]
            wanted_left = RUNS if case.expect else 0
            picked = ", ".join(f"{name or 'text'}x{n}" for name, n in chosen.items())
            verdict = "ok" if routed == RUNS else ("MISROUTED" if left == wanted_left else "FAIL")
            print(
                f"  {case.label:16} left {left}/{RUNS} "
                f" routed {routed}/{RUNS}  [{picked}]  {verdict}"
            )
            if verdict != "ok":
                failures.append(
                    f"{case.label}: wanted {case.expect or 'no call'} x{RUNS}, got {picked}"
                )

    assert not failures, "; ".join(failures)


def test_only_one_exit_claims_a_goodbye():
    """Exactly one exit may trigger on a goodbye, because they route apart.

    `talk_done` goes to `close`, which asks for the vote and is the point of the
    call. `global_stop_calling` goes to `respect`, the do-not-call path where
    nobody is ever asked. Until 2026-08-01 both claimed a goodbye: the task
    message (#65) told the model to call `talk_done` when "they say goodbye",
    and the `stop_calling` edge's `when` clause said "says goodbye" too. Which
    one fired was left to the model's instruction hierarchy.

    Measured on "תפסיקו להתקשר אלי, תורידו אותי מהרשימה", an explicit
    do-not-call: gemini-2.5-flash misrouted it to `talk_done` in both batches of
    three — 2/3 then 1/3, unstable but never zero — while gemma-4-31b chose
    `global_stop_calling` 3/3. Narrowing the edge to a do-not-call request took
    Gemini to 3/3 and left gemma unchanged.

    Needs no network: the collision is visible in the compiled node.
    """
    node = talk_node()
    task = " ".join(m.content for m in node.task_messages).lower()

    instructed = {f.name for f in node.functions if f.routes and f.name in task}
    described = {
        f.name for f in node.functions if f.routes and "says goodbye" in f.description.lower()
    }

    assert len(instructed | described) <= 1, (
        f"a goodbye triggers {sorted(instructed | described)} — instructed by the task "
        f"message: {sorted(instructed)}, claimed by a description: {sorted(described)}. "
        "Which one fires is decided by the model's instruction hierarchy."
    )
