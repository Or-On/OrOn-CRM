"""The packaged flow catalog: the flows this build ships, by id.

Lives here rather than in the agent so anything that *binds* a flow — the
tenancy control plane registering a DID — can check the id exists before storing
it, without depending on the agent.

They are the first thing a reader meets, so they use only registered components —
never the raw `nodes:` escape hatch.

Instructions to the model are English; `say` is spoken aloud, so it stays in the
flow's language.
"""

import uuid

from oron_flows.components.library import Announce, Branch, Choice, Collect, Converse, Inform
from oron_flows.compose import Composition, FlowMeta, GlobalEdge, Persona

# Fixed so a packaged flow keeps its identity across builds and databases.
EXAMPLE_HE_ID = uuid.UUID("0000f10d-0000-4000-8000-000000000001")
EXAMPLE_EN_ID = uuid.UUID("0000f10d-0000-4000-8000-000000000002")
SURVEY_HE_ID = uuid.UUID("0000f10d-0000-4000-8000-000000000003")
CANVASS_HE_ID = uuid.UUID("0000f10d-0000-4000-8000-000000000004")

_LEAVE = GlobalEdge(
    id="caller_goodbye",
    to="goodbye",
    when="the caller says goodbye or asks to end the call",
)

EXAMPLE_HE = Composition(
    flow=FlowMeta(id=EXAMPLE_HE_ID, version=1, language="he", name="מוקד לדוגמה"),
    persona=Persona(agent_name="נועה", org="המוקד", gender="female"),
    steps=[
        Inform(id="greeting", say="שלום, הגעתם למוקד. איך אפשר לעזור?"),
        Converse(
            id="collect_reason",
            # `say` speaks via tts_say on entry, costing no LLM call — script
            # every transition target worth scripting.
            say="בשמחה. במה אפשר לעזור?",
            task="Briefly find out why the caller is calling, then confirm you understood.",
        ),
        # `then` omitted: the authored line is the whole closing, and it is a
        # whole LLM call cheaper than letting the model compose one. Omitting it
        # does not silence the model by itself — the terminal node still takes a
        # turn — so the component swaps in an explicit stay-silent instruction.
        Announce(id="goodbye", say="תודה שפניתם, שיהיה יום נעים. להתראות."),
    ],
    globals=[_LEAVE],
)

EXAMPLE_EN = Composition(
    flow=FlowMeta(id=EXAMPLE_EN_ID, version=1, language="en", name="Example support line"),
    persona=Persona(agent_name="Noa", org="the support line", gender="female"),
    steps=[
        Converse(
            id="greeting",
            task=(
                "Open with a short greeting: 'Hello, you've reached the support "
                "line. How can I help?' then wait for the reply."
            ),
        ),
        Converse(
            id="collect_reason",
            say="Of course. What can I help you with?",
            task="Find out briefly why the caller is contacting us, and confirm you understood.",
        ),
        Announce(id="goodbye", then="Thank them, wish them a good day, and say goodbye."),
    ],
    globals=[_LEAVE],
)

# The first flow whose job is to come away with VALUES, not just to converse.
# Three turns, no branches — every fork the source script has needs a component
# that does not exist yet, so this is the half that is expressible today.
SURVEY_HE = Composition(
    flow=FlowMeta(id=SURVEY_HE_ID, version=1, language="he", name="סקר בחירות — קצר"),
    persona=Persona(
        agent_name="אור",
        org="מטה הבחירות",
        gender="female",
        # The G2P points אלי as "Ili"; heard live 2026-07-26. Authored here
        # rather than in the Hebrew package because it is this campaign's
        # vocabulary, not a property of the language.
        pronunciations={"אלי כהן": "אֵלִי כֹּהֵן"},
    ),
    steps=[
        Converse(
            id="ask_vote",
            say="שלום, מדברים ממטה הבחירות. רצינו לשאול שאלה קצרה אחת — למי אתם מתכוונים להצביע?",
            task="Find out who the voter intends to vote for. Do not argue or persuade.",
            collect=[
                Collect(
                    name="vote_intent",
                    describe="the party or candidate the voter named",
                    reask="רק שנייה — למי אתם מתכוונים להצביע?",
                )
            ],
            max_attempts=2,
            on={"exhausted": "thanks_partial"},
        ),
        Converse(
            id="ask_reason",
            say="מעולה, תודה. ואם אפשר — מה הסיבה העיקרית שמנחה אתכם בבחירתכם?",
            task="Find out their main reason. Sound genuinely curious, never formal.",
            collect=[
                Collect(
                    name="vote_reason",
                    describe="the main reason guiding their choice",
                    reask="ומה הסיבה העיקרית, אם אפשר?",
                )
            ],
            max_attempts=2,
            on={"exhausted": "thanks_partial"},
        ),
        Announce(id="thanks", say="תודה רבה ששיתפתם אותנו. אנחנו מעריכים את הזמן שלכם. יום טוב!"),
        # Reached when a voter will not answer. Same warmth: the iron rule of the
        # source script is to close with a smile even on a refusal.
        Announce(id="thanks_partial", say="תודה רבה על הזמן שלכם. יום טוב!"),
    ],
    globals=[_LEAVE.model_copy(update={"to": "thanks_partial"})],
)

# Track B: a canvassing CALL, not a script recital. Three nodes carry it —
# consent, one open conversation, the close — because a persuasion call is not a
# state machine. The first draft gave the pitch, the invitation and each rebuttal
# their own node; heard live 2026-07-26, the voter answered "אוקיי" and then
# "טוב" while the agent recited the next bullet at them regardless. Crossing a
# node boundary per sentence IS the recital. Only the two real decisions stay
# structural, because they are what the campaign needs recorded.
CANVASS_HE = Composition(
    flow=FlowMeta(id=CANVASS_HE_ID, version=1, language="he", name="שיחת שכנוע — אלי כהן"),
    persona=Persona(
        agent_name="אור",
        org="מטה הבחירות",
        gender="female",
        # The G2P points אלי as "Ili"; heard live 2026-07-26. Authored here
        # rather than in the Hebrew package because it is this campaign's
        # vocabulary, not a property of the language.
        pronunciations={"אלי כהן": "אֵלִי כֹּהֵן"},
    ),
    steps=[
        Branch(
            id="open",
            say="שלום, שמי אור ממטה הבחירות של השר אלי כהן. יש לך רגע אחד?",
            ask="whether the voter agreed to hear you out right now",
            choices={
                "yes": Choice(describe="They agreed to talk.", to="talk"),
                "no": Choice(
                    describe="They declined, are busy, or asked not to be called.",
                    to="respect",
                ),
            },
            sets="consent",
        ),
        Converse(
            id="talk",
            # Ends on a QUESTION, deliberately. `say` sets respond_immediately=False,
            # so whatever it ends on is what the caller is left holding — and a
            # statement leaves them holding nothing. Heard live 2026-07-26: the
            # agent stated its purpose and then waited 68 seconds.
            say=(
                "תודה. אז… רצינו לשתף אותך בכמה מחשבות על השר אלי כהן. "
                "אבל קודם — מה הכי חשוב לך שישתפר במדינה היום?"
            ),
            task=(
                "Have a real conversation about why Eli Cohen deserves their vote. You "
                "are a person on the phone, not a script being read.\n"
                "\n"
                "THE ONLY CLAIMS YOU MAY MAKE — never add facts beyond these four, and "
                "never invent news, polls, primaries or endorsements:\n"
                "1. He is a certified accountant who managed large budgets for years, so "
                "he understands the economy from the inside.\n"
                "2. He has served as Minister of Economy, Intelligence, Foreign Affairs, "
                "and now Energy and Infrastructure.\n"
                "3. His reforms saved the economy billions; he signed international "
                "agreements; he is overhauling energy infrastructure.\n"
                # The rank in Hebrew, not only in English: an English-only claim
                # costs a translation on every mention, and gemma-4-31b got it
                # wrong ~1 in 4 times it volunteered it — promoting a real
                # minister to סגן אלוף, once demoting him to סגן. Supplying the
                # token drops that to 0/15. Gemini is unaffected either way.
                "4. He is from Holon (חולון), a reserves major — in Hebrew his rank is "
                "exactly רב סרן, never any other — married with four children. He "
                "knows ordinary life first-hand.\n"
                "\n"
                # The four above are past record. Heard live 2026-07-27, the model
                # answered a question about tax with "he genuinely believes in
                # lowering the burden and lowering prices" — no invented *fact*,
                # so the rule above let it through, but a manufactured campaign
                # promise on behalf of a sitting minister all the same.
                "NEVER PROMISE ANYTHING. The four claims are his record; you have no "
                "mandate to say what he believes, intends, supports or will do. If they "
                "ask where he stands on something, say plainly that you cannot speak for "
                "him on it, then ask what makes it matter to them.\n"
                "\n"
                "NEVER END A TURN ON A STATEMENT. Every turn you take finishes with a "
                "question or an invitation to reply — a person who states a fact and "
                "goes silent leaves the other person waiting for nothing. If you have "
                "just made a point, ask what they make of it.\n"
                "\n"
                "HOW TO TALK. Offer ONE point at a time and then stop. If they answer "
                "with a flat 'אוקיי' or 'טוב' they are drifting — do not continue down "
                "the list. Ask them something instead: what matters to them, who they "
                "are leaning towards, what would change their mind. Follow what they say "
                "rather than what comes next in your material. Never deliver more than "
                "two points without them saying something substantive.\n"
                "\n"
                "IF THEY PUSH BACK, answer the objection they actually raised, calmly, "
                "and never raise your voice:\n"
                "- Party or leader, not the minister: do not defend the leadership. Talk "
                "about Eli Cohen personally, and ask if they would consider him himself.\n"
                "- All politicians lie: acknowledge the despair honestly, then point at a "
                "record of results rather than slogans.\n"
                "- Another candidate: ask what draws them there, listen, agree it sounds "
                "genuine, then ask whether that candidate has run economic and security "
                "portfolios the way he has.\n"
                "- Undecided: ask what troubles them most, and address just that.\n"
                "- Does not vote: respect it completely, then ask why, gently.\n"
                "\n"
                # converse_exit_description forbids narrating *while calling the
                # exit function*. It does not forbid signing off in an ordinary
                # turn and transitioning a beat later — which is exactly what
                # happened live on 2026-07-27: "תודה רבה לך על השיחה... יום
                # מקסים!", the caller answered "ביי ביי", and only then did the
                # flow reach `close` and ask for their vote. Hence a rule about
                # the conversation, not about the transition.
                # "Move on silently" never said *call a function*. Gemini inferred
                # it; gemma-4-31b obeyed the loud rule and kept selling through
                # "ביי ביי" — 6/12 exits vs Gemini's 12/12. Naming talk_done takes
                # both to 12/12. The rule was never robust; it was leaning on one
                # model's instruction hierarchy.
                "NEVER END THIS CONVERSATION IN TEXT. You do not say goodbye, do not "
                "thank them for their time, and do not wish them a good day.\n"
                "INSTEAD: the moment they signal they are finished — they say goodbye, "
                "say thank you, say 'that's it', or otherwise stop engaging — you MUST "
                "call the talk_done function and produce NO text at all. Calling it is "
                "how you leave; replying with another question is how you trap them. "
                "Another step handles the closing question and the farewell, and it "
                "cannot do its job if you have already signed off.\n"
                "Do NOT call it while they are still asking things or raising "
                "objections — answer those and keep going.\n"
                "\n"
                "Do not ask them for their vote yourself; the closing question comes next."
            ),
            on={"done": "close"},
        ),
        Branch(
            id="close",
            say=("אז מה דעתך — האם תשקול לתת את קולך לשר אלי כהן ולרשימת הליכוד בבחירות הקרובות?"),
            ask="how the voter answered the closing question",
            choices={
                "positive": Choice(describe="They said yes or leaned yes.", to="end_yes"),
                "undecided": Choice(describe="They are still weighing it.", to="end_maybe"),
                "negative": Choice(describe="They said no.", to="end_no"),
            },
            sets="closing_stance",
        ),
        Announce(id="end_yes", say="מעולה, תודה רבה! זה עושה שינוי. יום טוב!"),
        Announce(
            id="end_maybe",
            say="הבנתי. תודה ששקלת. אם תרצה לשמוע עוד — אנחנו כאן. יום טוב!",
        ),
        Announce(id="end_no", say="מכבד את דעתך לגמרי. תודה על הזמן והסבלנות. יום טוב!"),
        # The iron rule of the script: close with a smile in the voice even on a no.
        Announce(id="respect", say="בסדר גמור, מכבד את זה. יום טוב!"),
    ],
    globals=[
        # A do-not-call request ONLY. Unlike the other flows, canvass has a
        # `close` step that still has to ask for the vote, so an ordinary goodbye
        # belongs to talk_done — this edge used to claim it too, and
        # gemini-2.5-flash sent 1-2 of every 3 do-not-call requests to `close`
        # instead, asking for a vote from someone who had just demanded to be
        # left alone.
        GlobalEdge(
            id="stop_calling",
            to="respect",
            when="the caller asks to stop being called or to be taken off the list",
        )
    ],
)

SEED_COMPOSITIONS = {
    EXAMPLE_HE_ID: EXAMPLE_HE,
    EXAMPLE_EN_ID: EXAMPLE_EN,
    SURVEY_HE_ID: SURVEY_HE,
    CANVASS_HE_ID: CANVASS_HE,
}


def composition_for(flow_id: uuid.UUID) -> Composition:
    """The composition for `flow_id`, or the Hebrew example if this build does
    not ship it — a binding can outlive a deploy, and the caller is already
    connected by the time we look."""
    return SEED_COMPOSITIONS.get(flow_id, EXAMPLE_HE)
