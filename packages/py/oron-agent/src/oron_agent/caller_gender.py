"""Deterministic caller-gender state derived from explicit caller language.

Telephone-band acoustic gender classification is inherently uncertain.  It may
offer a provisional hint when explicitly enabled, but the caller's own words
are authoritative until the caller supplies a later correction. Grammatical
address is a preference, not identity verification.
"""

from __future__ import annotations

import re
from enum import StrEnum

from loguru import logger
from oron_flows import FlowSpec
from pipecat.frames.frames import (
    Frame,
    LLMMessagesAppendFrame,
    TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


class CallerGender(StrEnum):
    MALE = "male"
    FEMALE = "female"
    NEUTRAL = "neutral"
    UNKNOWN = "unknown"


class CallerGenderSource(StrEnum):
    ACOUSTIC = "acoustic"
    CONFIGURED = "configured"
    EXPLICIT = "explicit"


_FIRST_PERSON_GENDER_PATTERNS: tuple[tuple[CallerGender, re.Pattern[str]], ...] = (
    (
        CallerGender.MALE,
        re.compile(
            r"(?:^|[\s,.;!?])ו?אני(?:\s+(?:לא|כן|גם|דווקא|באמת))?\s+"
            r"(?:יכול|צריך|מעוניין|בטוח|מוכן|יודע)(?:$|[\s,.;!?])"
        ),
    ),
    (
        CallerGender.FEMALE,
        re.compile(
            r"(?:^|[\s,.;!?])ו?אני(?:\s+(?:לא|כן|גם|דווקא|באמת))?\s+"
            r"(?:יכולה|צריכה|מעוניינת|בטוחה|מוכנה|יודעת)(?:$|[\s,.;!?])"
        ),
    ),
    (
        CallerGender.MALE,
        re.compile(
            r"(?:^|[\s,.;!?])[וש]?אני(?:\s+(?:בעצם|דווקא|באמת))?\s+"
            r"(?:גבר|זכר|בחור|בן)(?:$|[\s,.;!?])"
        ),
    ),
    (
        CallerGender.FEMALE,
        re.compile(
            r"(?:^|[\s,.;!?])[וש]?אני(?:\s+(?:בעצם|דווקא|באמת))?\s+"
            r"(?:אישה|אשה|נקבה|בחורה|בת)(?:$|[\s,.;!?])"
        ),
    ),
    (
        CallerGender.MALE,
        re.compile(
            r"(?:דבר|דברי|דברו|תדבר|תדברי|תדברו|פנה|פני|פנו|תפנה|תפני|תפנו)"
            r"\s+(?:אלי|אליי|איתי)\s+בלשון\s+(?:זכר|זכרית)"
        ),
    ),
    (
        CallerGender.FEMALE,
        re.compile(
            r"(?:דבר|דברי|דברו|תדבר|תדברי|תדברו|פנה|פני|פנו|תפנה|תפני|תפנו)"
            r"\s+(?:אלי|אליי|איתי)\s+בלשון\s+(?:נקבה|נקבית)"
        ),
    ),
)

_QUOTED = re.compile(r'"[^"\n]*"|“[^”\n]*”|„[^”\n]*”|«[^»\n]*»|(?<!\w)\'[^\'\n]*\'(?!\w)')
_NEUTRAL_REQUEST = re.compile(
    r"(?:דבר|דברי|דברו|תדבר|תדברי|תדברו|פנה|פני|פנו|תפנה|תפני|תפנו)"
    r"\s+(?:אלי|אליי|איתי)\s+(?:בלשון\s+(?:ניטרלית|ניטרלי)|ללא\s+מגדר)"
    r"|(?:אני\s+מעדיפ[ה]?|ההעדפה\s+שלי)\s+(?:פנייה\s+)?(?:בלשון\s+)?ניטרלית"
)
_NEGATED_PREFIX = re.compile(
    r"(?:\b(?:לא|אל|בלי|שלא)|לא\s+(?:רוצה|מבקש|מבקשת)\s+ש?|don't|do not)\s*$",
    re.IGNORECASE,
)
_REPORTED_PREFIX = re.compile(
    r"(?:אמר[הת]?|אומר[הת]?|כתב[הת]?|מצטט[ת]?|שאל[הת]?|שואל[ת]?|אם|said|says|asked|quote)\s*(?:ש|:)?\s*$",
    re.IGNORECASE,
)
_CORRECTION = re.compile(r"\b(?:בעצם|תיקון|מעכשיו|אלא|התכוונתי|טעיתי)\b")
_ENGLISH_ADDRESS = re.compile(
    r"(?:address|speak to) me (?:in|using) (masculine|feminine|neutral)(?: language)?\b",
    re.IGNORECASE,
)
_PREFERRED_FORM = re.compile(r"אני\s+מעדיפ[ה]?\s+(?:פנייה\s+)?(?:ב?לשון\s+)(זכר|נקבה|ניטרלית)")
_UNKNOWN_FORM = re.compile(r"אין\s+לי\s+העדפה\s+(?:מגדרית|(?:לגבי\s+|ב)?(?:לשון|צורת)\s+הפנייה)")


def detect_explicit_caller_gender(text: str) -> CallerGender | None:
    """Return only an explicit first-person gender declaration.

    References to somebody else (for example ``יש לי בן``) deliberately do not
    count. The detector is conservative because a missed hint merely keeps the
    conversation neutral, while a false match misgenders the caller.
    """

    normalized = _QUOTED.sub(lambda match: " " * len(match.group()), " ".join(text.split()))
    matches: list[tuple[int, CallerGender, int]] = []
    for index, (gender, pattern) in enumerate(_FIRST_PERSON_GENDER_PATTERNS):
        for match in pattern.finditer(normalized):
            prefix = normalized[: match.start()].rstrip()
            if _NEGATED_PREFIX.search(prefix) or _REPORTED_PREFIX.search(prefix):
                continue
            matches.append((match.start(), gender, 2 if index >= 4 else 1))
    for match in _NEUTRAL_REQUEST.finditer(normalized):
        prefix = normalized[: match.start()].rstrip()
        if not (_NEGATED_PREFIX.search(prefix) or _REPORTED_PREFIX.search(prefix)):
            matches.append((match.start(), CallerGender.NEUTRAL, 2))
    for match in _ENGLISH_ADDRESS.finditer(normalized):
        prefix = normalized[: match.start()].rstrip()
        if not (_NEGATED_PREFIX.search(prefix) or _REPORTED_PREFIX.search(prefix)):
            matches.append(
                (
                    match.start(),
                    {
                        "masculine": CallerGender.MALE,
                        "feminine": CallerGender.FEMALE,
                        "neutral": CallerGender.NEUTRAL,
                    }[match.group(1).lower()],
                    2,
                )
            )
    for pattern in (_PREFERRED_FORM, _UNKNOWN_FORM):
        for match in pattern.finditer(normalized):
            prefix = normalized[: match.start()].rstrip()
            if _NEGATED_PREFIX.search(prefix) or _REPORTED_PREFIX.search(prefix):
                continue
            preference = (
                CallerGender.UNKNOWN
                if pattern is _UNKNOWN_FORM
                else {
                    "זכר": CallerGender.MALE,
                    "נקבה": CallerGender.FEMALE,
                    "ניטרלית": CallerGender.NEUTRAL,
                }[match.group(1)]
            )
            matches.append((match.start(), preference, 2))
    if not matches:
        return None
    # An actual address request is stronger than the grammar used while asking.
    strongest = max(priority for _, _, priority in matches)
    matches = [match for match in matches if match[2] == strongest]
    matches.sort(key=lambda item: item[0])
    choices = {gender for _, gender, _ in matches}
    if len(choices) == 1:
        return matches[-1][1]
    # Contradictory declarations have no safe default. A clearly introduced
    # self-correction can select the latest positive declaration instead.
    if _CORRECTION.search(normalized[matches[0][0] : matches[-1][0]]):
        return matches[-1][1]
    return None


def caller_gender_instruction(
    gender: CallerGender,
    *,
    explicit: bool,
    configured: bool = False,
    persona_gender: str | None = None,
) -> str:
    if explicit:
        authority = (
            "The caller explicitly selected their grammatical address. This is authoritative and "
            "overrides every name-based, configured, or acoustic inference."
        )
    elif configured:
        authority = (
            "This address form was explicitly selected for this call. It is authoritative "
            "unless the caller personally corrects it."
        )
    else:
        authority = "This is a provisional trusted acoustic classification."
    if gender is CallerGender.MALE:
        forms = (
            "Use masculine Hebrew when addressing the caller: "
            "אתה, תוכל, תרצה, צריך, יודע. Never address him as את, תוכלי, תרצי, צריכה, "
            "or יודעת."
        )
    elif gender is CallerGender.FEMALE:
        forms = (
            "Use feminine Hebrew when addressing the caller: "
            "את, תוכלי, תרצי, צריכה, יודעת. Never address her as אתה, תוכל, תרצה, צריך, "
            "or יודע. Your own speaking gender is a separate instruction."
        )
    else:
        forms = (
            "Use naturally neutral Hebrew address, for example אפשר להמשיך? or מה מתאים? "
            "Avoid gendered second-person forms and never speak slash forms such as את/ה. "
            "Unknown means the caller has not supplied a preference. Do not guess from names, "
            "voices or identity stereotypes."
        )
    if persona_gender == "female":
        separation = (
            " The agent is female, so אני מבינה may describe YOURSELF correctly; it must never "
            "make you address the caller in feminine second-person grammar."
        )
    elif persona_gender == "male":
        separation = (
            " The agent is male, so אני מבין may describe YOURSELF correctly; caller address "
            "grammar still follows the separate caller form above."
        )
    else:
        separation = " Your own first-person grammar is separate from the caller's address form."
    return (
        "CALLER ADDRESS UPDATE: "
        f"{authority} {forms}{separation} Keep this choice until a later caller correction; "
        "a later CALLER ADDRESS UPDATE overrides this one, including any operator default. "
        "This preference does not establish biological sex or identity. "
        "If this follows a correction, acknowledge it briefly in your own words and "
        "continue with the caller's request. Do not discuss how gender was detected."
    )


def apply_caller_gender_to_flow(spec: FlowSpec, gender: CallerGender) -> FlowSpec:
    """Make the selected address form part of Pipecat's primary system instruction.

    Pipecat applies a node ``role_message`` as the provider system instruction
    after the context has been created. A system message placed only in the
    initial conversation history can therefore lose precedence. Add the rule to
    the flow-wide role and every node-specific override instead.
    """

    instruction = caller_gender_instruction(
        gender,
        explicit=False,
        configured=True,
        persona_gender=spec.persona_gender,
    )

    def append(role: str | None) -> str:
        return f"{role.strip()}\n\n{instruction}" if role and role.strip() else instruction

    nodes = [
        node.model_copy(update={"role_message": append(node.role_message)})
        if node.role_message is not None
        else node
        for node in spec.nodes
    ]
    return spec.model_copy(update={"role_message": append(spec.role_message), "nodes": nodes})


class CallerGenderState:
    """Per-call caller gender, with explicit speech stronger than audio inference."""

    def __init__(self, configured: CallerGender | None = None) -> None:
        self.gender = configured
        self.source = CallerGenderSource.CONFIGURED if configured is not None else None

    @property
    def tts_value(self) -> str | None:
        return self.gender.value if self.gender is not None else None

    def observe_acoustic(self, gender: str) -> CallerGender | None:
        if self.source in {CallerGenderSource.CONFIGURED, CallerGenderSource.EXPLICIT}:
            return None
        try:
            detected = CallerGender(gender)
        except ValueError:
            return None
        if detected not in {CallerGender.MALE, CallerGender.FEMALE}:
            return None
        if self.gender is detected and self.source is CallerGenderSource.ACOUSTIC:
            return None
        self.gender = detected
        self.source = CallerGenderSource.ACOUSTIC
        return detected

    def observe_transcript(self, text: str) -> CallerGender | None:
        detected = detect_explicit_caller_gender(text)
        if detected is None:
            return None
        if self.gender is detected and self.source is CallerGenderSource.EXPLICIT:
            return None
        self.gender = detected
        self.source = CallerGenderSource.EXPLICIT
        return detected


class CallerGenderContextProcessor(FrameProcessor):
    """Promote explicit caller wording into LLM context before inference."""

    def __init__(
        self,
        state: CallerGenderState,
        *,
        session_id: str,
        persona_gender: str | None = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._state = state
        self._session_id = session_id
        self._persona_gender = persona_gender

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        # Each final frame is an accepted segment. Reusing previous final
        # declarations made an earlier preference shadow a later correction.
        if (
            direction is FrameDirection.DOWNSTREAM
            and isinstance(frame, TranscriptionFrame)
            and (detected := self._state.observe_transcript(frame.text))
        ):
            logger.info(
                "Caller explicitly set address form: {} (session={})",
                detected.value,
                self._session_id,
            )
            # This frame must reach the user aggregator before the transcription.
            # It updates context without triggering a second LLM request.
            await self.push_frame(
                LLMMessagesAppendFrame(
                    messages=[
                        {
                            "role": "system",
                            "content": caller_gender_instruction(
                                detected,
                                explicit=True,
                                persona_gender=self._persona_gender,
                            ),
                        }
                    ],
                    run_llm=False,
                ),
                direction,
            )
        await self.push_frame(frame, direction)
