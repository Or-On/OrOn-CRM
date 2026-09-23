"""Executable service-agent scope policy shared with the WhatsApp runtime.

The canonical data lives in ``db/contracts/service-agent-policy.v1.json`` and
is mirrored into :mod:`oron_agent.scope_policy_contract`. The model may propose
wording; this module decides whether a caller turn is answered by an approved
server response and whether generated wording may reach the caller at all.

It is a platform protection: tenant configuration supplies only the trusted
business display name used inside the approved wording.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Final

from oron_agent.scope_policy_contract import POLICY

POLICY_VERSION: Final[str] = POLICY["policyVersion"]

_STRIP = re.compile(
    "[\u0591-\u05c7\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]"
)
_JOINERS = re.compile("[" + re.escape(POLICY["normalization"]["joiners"]) + "]")
_OUTSIDE = re.compile("[^" + POLICY["normalization"]["keep"] + "]+")


def normalize(text: str) -> str:
    """The policy's single normalization; the TypeScript runtime mirrors it exactly."""

    value = unicodedata.normalize("NFKC", text)
    value = _STRIP.sub("", value).lower()
    value = _JOINERS.sub("", value)
    value = _OUTSIDE.sub(" ", value)
    return " " + " ".join(value.split()) + " "


def _compile(patterns: list[str]) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(pattern) for pattern in patterns)


_TURN_PATTERNS: Final[dict[str, tuple[re.Pattern[str], ...]]] = {
    category: _compile(patterns) for category, patterns in POLICY["turnCategories"].items()
}
_SERVICE_PATTERNS: Final = _compile(POLICY["serviceSignals"])
_OUTPUT_PATTERNS: Final[dict[str, tuple[re.Pattern[str], ...]]] = {
    category: _compile(patterns) for category, patterns in POLICY["outputCategories"].items()
}
_RAW_OUTPUT_PATTERNS: Final[dict[str, tuple[re.Pattern[str], ...]]] = {
    category: _compile(patterns) for category, patterns in POLICY["rawOutputPatterns"].items()
}
_ROUTED: Final[frozenset[str]] = frozenset(POLICY["routing"]["routedCategories"])
_RESPONSE_FOR: Final[dict[str, str]] = POLICY["routing"]["responseForCategory"]
_ROUTE_PRIORITY: Final[tuple[str, ...]] = tuple(POLICY["routing"]["routePriority"])
_RESPONSES: Final[dict[str, dict[str, str]]] = POLICY["approvedResponses"]


@dataclass(frozen=True)
class TurnDecision:
    """How the server treats one caller turn.

    ``route`` names an approved response the server delivers itself, or is
    None when the conversational model may answer. ``mixed`` lists restricted
    categories found in a turn that also carries a service request: the model
    still answers, with a scope notice, and its output is still validated.
    """

    categories: frozenset[str] = field(default_factory=frozenset)
    service_signal: bool = False
    route: str | None = None
    mixed: tuple[str, ...] = ()

    @property
    def restricted(self) -> tuple[str, ...]:
        return tuple(sorted(self.categories & _ROUTED))


@dataclass(frozen=True)
class OutputVerdict:
    allowed: bool
    category: str | None = None


def classify_turn(text: str) -> TurnDecision:
    if not isinstance(text, str) or not text.strip():
        return TurnDecision()
    normalized = normalize(text[:8192])
    categories = frozenset(
        category
        for category, patterns in _TURN_PATTERNS.items()
        if any(pattern.search(normalized) for pattern in patterns)
    )
    service = any(pattern.search(normalized) for pattern in _SERVICE_PATTERNS)
    restricted = sorted(categories & _ROUTED)
    if not restricted:
        return TurnDecision(categories, service)
    if service:
        return TurnDecision(categories, service, None, tuple(restricted))
    responses = {_RESPONSE_FOR[category] for category in restricted}
    route = next(response for response in _ROUTE_PRIORITY if response in responses)
    return TurnDecision(categories, service, route)


def validate_output(text: str, *, approved: frozenset[str] = frozenset()) -> OutputVerdict:
    """Reject customer-visible wording that leaves the service scope.

    Exact server-approved responses are always allowed, so a business whose
    configured name happens to contain a vendor word does not silence its own
    approved line.
    """

    if not isinstance(text, str):
        return OutputVerdict(False, "invalid")
    stripped = text.strip()
    if not stripped:
        return OutputVerdict(True)
    if stripped in approved:
        return OutputVerdict(True)
    for category, patterns in _RAW_OUTPUT_PATTERNS.items():
        if any(pattern.search(stripped) for pattern in patterns):
            return OutputVerdict(False, category)
    normalized = normalize(stripped[:8192])
    for category, patterns in _OUTPUT_PATTERNS.items():
        if any(pattern.search(normalized) for pattern in patterns):
            return OutputVerdict(False, category)
    return OutputVerdict(True)


def _language_key(language: str) -> str:
    return "he" if str(language).lower().startswith("he") else "en"


def approved_response(kind: str, language: str, business_name: str | None) -> str:
    key = _language_key(language)
    name = (business_name or "").strip()[:120] or _RESPONSES["businessFallbackName"][key]
    return _RESPONSES[kind][key].replace("{business}", name)


def approved_responses(business_name: str | None) -> frozenset[str]:
    return frozenset(
        approved_response(kind, language, business_name)
        for kind in ("identity", "scope", "data", "recipient", "fallback")
        for language in ("he", "en")
    )


def scope_notice(categories: tuple[str, ...]) -> str:
    return POLICY["scopeNotice"].replace("{categories}", ", ".join(categories))
