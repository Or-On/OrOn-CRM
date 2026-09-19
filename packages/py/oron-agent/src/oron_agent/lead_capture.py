"""Voice consumer of the canonical lead capture contract.

The rules live in ``db/contracts/lead-capture.v1.json``. This module reads its
generated mirror, normalizes what a caller said exactly as the TypeScript
WhatsApp runtime does (both run the contract's parity fixtures), and hands the
result to the same ``platform.lead_*`` PostgreSQL functions. Those functions own
binding checks, the pinned agent's capability, worker fencing, idempotency,
revision checks and the durable receipt. Nothing here writes a lead row.

JavaScript is the reference semantics for the shared rules because the contract
was first expressed there, so trimming, string lengths (UTF-16 code units),
number formatting and currency rounding follow it deliberately rather than
Python's own defaults.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal, Protocol

from oron_agent.lead_capture_contract import CONTRACT

_LIMITS: Mapping[str, Any] = CONTRACT["limits"]
_PATTERNS: Mapping[str, str] = CONTRACT["patterns"]

FIELD_TYPES: tuple[str, ...] = tuple(CONTRACT["enums"]["fieldTypes"])
FIELD_STATES: tuple[str, ...] = tuple(CONTRACT["enums"]["fieldStates"])
CONFIRMATIONS: tuple[str, ...] = tuple(CONTRACT["enums"]["confirmations"])
TOOL_NAMES: tuple[str, ...] = tuple(
    definition["name"] for definition in CONTRACT["tools"]["definitions"]
)


def _compile(source: str) -> re.Pattern[str]:
    # JavaScript's "$" means end of input; Python's also matches before a final
    # newline. The contract's patterns use "$" only as that anchor.
    return re.compile(source.replace("$", r"\Z"))


_TRIMMABLE = _compile(_PATTERNS["trimmable"])
_FIELD_KEY = _compile(_PATTERNS["fieldKey"])
_EMAIL = _compile(_PATTERNS["email"])
_PHONE_SEPARATORS = _compile(_PATTERNS["phoneSeparators"])
_NON_DIGIT = _compile(_PATTERNS["nonDigit"])
_E164 = _compile(_PATTERNS["e164"])
_NUMBER_SPACING = _compile(_PATTERNS["numberSpacing"])
_THOUSANDS_COMMA = _compile(_PATTERNS["thousandsComma"])
_DECIMAL_NUMBER = _compile(_PATTERNS["decimalNumber"])
_ISO_DATE = _compile(_PATTERNS["isoDate"])
_ISO_INSTANT = _compile(_PATTERNS["isoInstant"])
_CURRENCY = _compile(_PATTERNS["currency"])
_IL_NATIONAL = _compile(CONTRACT["phoneRegions"]["IL"]["national"])
_OFFSET = re.compile(r"([+-])([0-9]{2}):([0-9]{2})\Z")


def trim(value: str) -> str:
    """The contract's trim: the characters JavaScript's ``String#trim`` removes."""

    return _TRIMMABLE.sub("", value)


def utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def js_number_string(value: float) -> str:
    """Format a finite number exactly as JavaScript's ``String(number)`` does."""

    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    sign = "-" if value < 0 else ""
    # repr() yields the shortest round-tripping digits, as JavaScript does.
    normalized = Decimal(repr(abs(value))).normalize()
    _, digits_tuple, exponent = normalized.as_tuple()
    digits = "".join(str(digit) for digit in digits_tuple)
    k = len(digits)
    n = k + int(exponent)
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        mantissa = digits if k == 1 else f"{digits[0]}.{digits[1:]}"
        body = f"{mantissa}e{'+' if n - 1 >= 0 else '-'}{abs(n - 1)}"
    return sign + body


def to_fixed(value: float, digits: int) -> str:
    """JavaScript ``toFixed``: the double's exact value, rounded half up."""

    quantum = Decimal(1).scaleb(-digits)
    return str(Decimal(value).quantize(quantum, rounding=ROUND_HALF_UP))


class LeadSchemaError(ValueError):
    code = "invalid_schema"


class LeadFieldValidationError(ValueError):
    """A value the contract rejects; ``code`` is stable, ``reason`` is English."""

    def __init__(self, field_key: str, reason: str, code: str) -> None:
        super().__init__(f"{field_key}: {reason}")
        self.field = field_key
        self.reason = reason
        self.code = code


@dataclass(frozen=True)
class LeadFieldDefinition:
    key: str
    label: str
    type: str
    required: bool
    description: str | None = None
    choices: tuple[str, ...] | None = None
    max_length: int | None = None
    minimum: float | None = None
    maximum: float | None = None


@dataclass(frozen=True)
class LeadFieldSchema:
    fields: tuple[LeadFieldDefinition, ...]

    def field(self, key: str) -> LeadFieldDefinition | None:
        return next((entry for entry in self.fields if entry.key == key), None)


def _schema_error(message: str) -> LeadSchemaError:
    return LeadSchemaError(f"lead field schema: {message}")


def _finite_number(value: object) -> bool:
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _parse_choices(value: object, key: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= _LIMITS["choices"]:
        raise _schema_error(f"{key} requires between 1 and {_LIMITS['choices']} choices")
    choices: list[str] = []
    for choice in value:
        if not isinstance(choice, str):
            raise _schema_error(f"{key} has an invalid choice")
        trimmed = trim(choice)
        if not trimmed or utf16_length(trimmed) > _LIMITS["choiceLength"]:
            raise _schema_error(f"{key} has an invalid choice")
        choices.append(trimmed)
    if len({choice.lower() for choice in choices}) != len(choices):
        raise _schema_error(f"{key} has duplicate choices")
    return tuple(choices)


def _parse_definition(value: object) -> LeadFieldDefinition:
    if not isinstance(value, dict):
        raise _schema_error("each field must be an object")
    raw_key = value.get("key")
    key = trim(raw_key) if isinstance(raw_key, str) else ""
    if not _FIELD_KEY.match(key):
        raise _schema_error(f"invalid field key: {json.dumps(raw_key)}")
    raw_label = value.get("label")
    label = trim(raw_label) if isinstance(raw_label, str) else ""
    if not label or utf16_length(label) > _LIMITS["labelLength"]:
        raise _schema_error(f"{key} requires a label of 1-{_LIMITS['labelLength']} characters")
    field_type = value.get("type")
    if not isinstance(field_type, str) or field_type not in FIELD_TYPES:
        raise _schema_error(f"{key} has an unsupported type")
    required = value.get("required")
    if not isinstance(required, bool):
        raise _schema_error(f"{key} must declare required explicitly")
    raw_description = value.get("description")
    description = trim(raw_description) if isinstance(raw_description, str) else ""
    if utf16_length(description) > _LIMITS["descriptionLength"]:
        raise _schema_error(f"{key} description is too long")
    max_length = value.get("maxLength")
    if max_length is not None and not (
        _finite_number(max_length)
        and float(max_length).is_integer()
        and 1 <= max_length <= _LIMITS["maxLengthCeiling"]
    ):
        raise _schema_error(f"{key} maxLength is out of range")
    bounds: dict[str, float | None] = {}
    for bound in ("minimum", "maximum"):
        candidate = value.get(bound)
        if candidate is not None and not _finite_number(candidate):
            raise _schema_error(f"{key} {bound} must be a finite number")
        bounds[bound] = candidate
    if (
        bounds["minimum"] is not None
        and bounds["maximum"] is not None
        and bounds["minimum"] > bounds["maximum"]
    ):
        raise _schema_error(f"{key} minimum exceeds maximum")
    if field_type != "choice" and value.get("choices") is not None:
        raise _schema_error(f"{key} may only declare choices for a choice field")
    return LeadFieldDefinition(
        key=key,
        label=label,
        type=field_type,
        required=required,
        description=description or None,
        choices=_parse_choices(value.get("choices"), key) if field_type == "choice" else None,
        max_length=int(max_length) if max_length is not None else None,
        minimum=bounds["minimum"],
        maximum=bounds["maximum"],
    )


def parse_lead_field_schema(value: object) -> LeadFieldSchema:
    if isinstance(value, dict) and isinstance(value.get("fields"), list):
        entries = value["fields"]
    elif isinstance(value, list):
        entries = value
    else:
        raise _schema_error("definition must be an array of fields")
    if not entries:
        raise _schema_error("at least one field is required")
    if len(entries) > _LIMITS["schemaFields"]:
        raise _schema_error(f"at most {_LIMITS['schemaFields']} fields are supported")
    fields = tuple(_parse_definition(entry) for entry in entries)
    if len({entry.key for entry in fields}) != len(fields):
        raise _schema_error("field keys must be unique")
    return LeadFieldSchema(fields=fields)


def _normalize_e164(value: str) -> str | None:
    trimmed = trim(value)
    candidate = "+" + _NON_DIGIT.sub("", trimmed)
    if not trimmed.startswith("+") or not _E164.match(candidate):
        return None
    return candidate


def _normalize_phone(raw: str, phone_region: str | None, key: str) -> str:
    compact = _PHONE_SEPARATORS.sub("", raw)
    explicit = _normalize_e164(compact)
    if explicit is not None:
        return explicit
    if phone_region == "IL":
        national = _IL_NATIONAL.match(compact)
        if national is not None:
            region = CONTRACT["phoneRegions"]["IL"]["countryCode"]
            normalized = _normalize_e164(f"+{region}{national.group(1)}")
            if normalized is not None:
                return normalized
    raise LeadFieldValidationError(
        key,
        "a phone number must be international (+...) or a recognised local number",
        "invalid_phone",
    )


def _normalize_number(raw: str, key: str) -> float:
    compact = _THOUSANDS_COMMA.sub("", _NUMBER_SPACING.sub("", raw)).replace(",", ".", 1)
    if not _DECIMAL_NUMBER.match(compact):
        raise LeadFieldValidationError(key, "expected a number", "invalid_number")
    parsed = float(compact)
    if not math.isfinite(parsed) or abs(parsed) >= _LIMITS["absoluteNumber"]:
        raise LeadFieldValidationError(key, "is implausibly large", "number_too_large")
    return parsed


def _apply_bounds(definition: LeadFieldDefinition, parsed: float) -> None:
    if definition.minimum is not None and parsed < definition.minimum:
        raise LeadFieldValidationError(
            definition.key, f"must be at least {definition.minimum}", "below_minimum"
        )
    if definition.maximum is not None and parsed > definition.maximum:
        raise LeadFieldValidationError(
            definition.key, f"must be at most {definition.maximum}", "above_maximum"
        )


def _real_date(year: int, month: int, day: int) -> bool:
    try:
        date(year, month, day)
    except ValueError:
        return False
    return True


def _valid_instant(value: str) -> bool:
    """Checked field by field, exactly as the TypeScript side checks it."""

    if not _ISO_INSTANT.match(value):
        return False
    day_part, _, rest = value.partition("T")
    year, month, day = (int(part) for part in day_part.split("-"))
    if not _LIMITS["dateYearMin"] <= year <= _LIMITS["dateYearMax"]:
        return False
    if not _real_date(year, month, day):
        return False
    clock = re.sub(r"(?:Z|[+-][0-9]{2}:[0-9]{2})\Z", "", rest).split(":")
    hour, minute = int(clock[0]), int(clock[1])
    second = float(clock[2]) if len(clock) > 2 else 0.0
    if hour > 23 or minute > 59 or math.floor(second) > 59:
        return False
    offset = _OFFSET.search(rest)
    return offset is None or (int(offset.group(2)) <= 23 and int(offset.group(3)) <= 59)


def _normalize_known(
    definition: LeadFieldDefinition,
    raw: str,
    observation: Mapping[str, Any],
    phone_region: str | None,
) -> tuple[str, str | None]:
    key = definition.key
    if definition.type in {"text", "choice"}:
        limit = definition.max_length or _LIMITS["defaultTextLength"]
        if utf16_length(raw) > limit:
            raise LeadFieldValidationError(
                key, f"must be at most {limit} characters", "text_too_long"
            )
        if definition.type == "text":
            return raw, None
        match = next(
            (choice for choice in definition.choices or () if choice.lower() == raw.lower()),
            None,
        )
        if match is None:
            raise LeadFieldValidationError(
                key, f"must be one of: {', '.join(definition.choices or ())}", "invalid_choice"
            )
        return match, None
    if definition.type == "email":
        lowered = raw.lower()
        if not _EMAIL.match(lowered):
            raise LeadFieldValidationError(key, "expected an email address", "invalid_email")
        return lowered, None
    if definition.type == "phone":
        return _normalize_phone(raw, phone_region, key), None
    if definition.type == "boolean":
        lowered = raw.lower()
        if lowered in CONTRACT["booleanTokens"]["true"]:
            return "true", None
        if lowered in CONTRACT["booleanTokens"]["false"]:
            return "false", None
        raise LeadFieldValidationError(key, "expected yes or no", "invalid_boolean")
    if definition.type == "number":
        parsed = _normalize_number(raw, key)
        _apply_bounds(definition, parsed)
        return js_number_string(parsed), None
    if definition.type == "currency":
        raw_currency = observation.get("currency")
        currency = trim(raw_currency).upper() if isinstance(raw_currency, str) else ""
        if not _CURRENCY.match(currency):
            raise LeadFieldValidationError(
                key, "an amount requires an ISO 4217 currency code", "currency_required"
            )
        parsed = _normalize_number(raw, key)
        if parsed < 0:
            raise LeadFieldValidationError(key, "must not be negative", "negative_amount")
        _apply_bounds(definition, parsed)
        return to_fixed(parsed, CONTRACT["rounding"]["currencyDecimals"]), currency
    # date
    match_date = _ISO_DATE.match(raw)
    if match_date is None:
        raise LeadFieldValidationError(
            key, "expected an exact calendar date (YYYY-MM-DD)", "invalid_date_format"
        )
    year = int(match_date.group(1))
    if not _LIMITS["dateYearMin"] <= year <= _LIMITS["dateYearMax"]:
        raise LeadFieldValidationError(
            key,
            f"must fall between {_LIMITS['dateYearMin']} and {_LIMITS['dateYearMax']}",
            "date_out_of_range",
        )
    if not _real_date(year, int(match_date.group(2)), int(match_date.group(3))):
        raise LeadFieldValidationError(key, "is not a real calendar date", "invalid_calendar_date")
    return raw, None


def _now_instant() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_lead_field(
    schema: LeadFieldSchema,
    observation: Mapping[str, Any],
    *,
    phone_region: Literal["IL"] | None = None,
) -> dict[str, Any]:
    """Normalize one observation; the result is what ``platform.lead_*`` stores."""

    key = str(observation.get("key", ""))
    definition = schema.field(key)
    if definition is None:
        raise LeadFieldValidationError(
            key, "is not part of this lead's reviewed field schema", "unknown_field"
        )
    state = observation.get("state")
    if state not in FIELD_STATES:
        raise LeadFieldValidationError(key, "has an unsupported state", "unsupported_state")
    # "is None", not "or": an empty string is an invalid value, as it is in
    # TypeScript's "??", and must not silently become the default.
    confirmation = observation.get("confirmation")
    if confirmation is None:
        confirmation = "unconfirmed"
    if confirmation not in CONFIRMATIONS:
        raise LeadFieldValidationError(
            key, "has an unsupported confirmation status", "unsupported_confirmation"
        )
    observed_at = observation.get("observedAt")
    if observed_at is None:
        observed_at = _now_instant()
    if not isinstance(observed_at, str) or not _valid_instant(observed_at):
        raise LeadFieldValidationError(
            key, "has an invalid observation time", "invalid_observed_at"
        )
    raw_reference = observation.get("sourceReferenceId")
    reference = trim(raw_reference) if isinstance(raw_reference, str) else ""
    if utf16_length(reference) > _LIMITS["sourceReferenceLength"]:
        raise LeadFieldValidationError(key, "source reference is too long", "reference_too_long")
    base = {
        "key": definition.key,
        "type": definition.type,
        "confirmation": confirmation,
        "observedAt": observed_at,
        "sourceReferenceId": reference or None,
    }
    value = observation.get("value")
    if state != "known":
        if isinstance(value, str) and trim(value):
            raise LeadFieldValidationError(
                key, "only a known value may carry content", "content_without_known"
            )
        return {**base, "state": state, "rawValue": None, "normalizedValue": None, "currency": None}
    raw = trim(value) if isinstance(value, str) else ""
    if not raw:
        raise LeadFieldValidationError(
            key,
            "a known value cannot be blank; use unknown, declined or not_applicable",
            "blank_known",
        )
    if utf16_length(raw) > _LIMITS["rawValueLength"]:
        raise LeadFieldValidationError(key, "value is too long", "value_too_long")
    normalized, currency = _normalize_known(definition, raw, observation, phone_region)
    return {
        **base,
        "state": "known",
        "rawValue": raw,
        "normalizedValue": normalized,
        "currency": currency,
    }


def lead_completeness(
    schema: LeadFieldSchema, current: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    """Deterministic: a declined required field is answered, not missing."""

    states = {str(entry.get("key")): entry.get("state") for entry in current}
    required = [entry.key for entry in schema.fields if entry.required]
    satisfied: list[str] = []
    missing: list[str] = []
    declined: list[str] = []
    for key in required:
        state = states.get(key)
        if state == "known":
            satisfied.append(key)
        elif state in {"declined", "not_applicable"}:
            declined.append(key)
            satisfied.append(key)
        else:
            missing.append(key)
    return {
        "required": required,
        "satisfied": satisfied,
        "missing": missing,
        "declined": declined,
        "complete": not missing,
    }


def effective_capabilities(capabilities: Sequence[str]) -> frozenset[str]:
    granted = set(capabilities)
    for implied, sources in CONTRACT["tools"]["capabilityImplies"].items():
        if granted.intersection(sources):
            granted.add(implied)
    return frozenset(granted)


def observation_item_schema(schema: LeadFieldSchema) -> dict[str, Any]:
    describe = CONTRACT["tools"]["observationItem"]
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["key", "state"],
        "properties": {
            "key": {
                "type": "string",
                "enum": [entry.key for entry in schema.fields],
                "description": describe["key"],
            },
            "state": {
                "type": "string",
                "enum": list(FIELD_STATES),
                "description": describe["state"],
            },
            "value": {"type": "string", "description": describe["value"]},
            "currency": {"type": "string", "description": describe["currency"]},
            "confirmed": {"type": "boolean", "description": describe["confirmed"]},
            "sourceReference": {"type": "string", "description": describe["sourceReference"]},
        },
    }


@dataclass(frozen=True)
class LeadToolDescriptor:
    name: str
    description: str
    capability: str
    mutating: bool
    properties: dict[str, Any]
    required: list[str]


def lead_tool_descriptors(
    capabilities: Sequence[str], schema: LeadFieldSchema
) -> list[LeadToolDescriptor]:
    """Exactly the tools the pinned version was published with, from the contract."""

    granted = effective_capabilities(capabilities)
    descriptors: list[LeadToolDescriptor] = []
    for definition in CONTRACT["tools"]["definitions"]:
        if definition["capability"] not in granted:
            continue
        if definition["name"] == "lead_save_fields":
            properties: dict[str, Any] = {
                "observations": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": CONTRACT["tools"]["maxObservationsPerCall"],
                    "items": observation_item_schema(schema),
                }
            }
            required = ["observations"]
        else:
            properties = {
                name: {key: value for key, value in argument.items() if key != "required"}
                for name, argument in definition["arguments"].items()
            }
            required = [
                name for name, argument in definition["arguments"].items() if argument["required"]
            ]
        descriptors.append(
            LeadToolDescriptor(
                name=definition["name"],
                description=definition["description"],
                capability=definition["capability"],
                mutating=definition["mutating"],
                properties=properties,
                required=required,
            )
        )
    return descriptors


# ---------------------------------------------------------------------------
# Durable store port and the voice tool runtime.


class LeadStoreRefusal(Exception):
    """The database refused the action for this binding. Nothing was written."""

    def __init__(self, code: str, message: str, *, current_revision: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.current_revision = current_revision


class LeadStore(Protocol):
    """``platform.lead_*`` as seen from voice. The binding is resolved by the
    persistence adapter from the call itself, never from model output."""

    async def capture_state(self, lead_id: str | None) -> dict | None: ...

    async def ensure(self, operation_key: str) -> dict: ...

    async def save_fields(
        self, lead_id: str, operation_key: str, observations: list[dict[str, Any]]
    ) -> dict: ...

    async def finalize(
        self, lead_id: str, operation_key: str, summary: str, next_action: str | None
    ) -> dict: ...

    async def follow_up(
        self, lead_id: str, operation_key: str, note: str, due_at: str | None
    ) -> dict: ...

    async def operation_receipt(self, operation_key: str) -> dict | None: ...


class LeadOutcomeUnknown(Exception):
    """A write whose commit could neither be confirmed nor ruled out."""

    def __init__(self, operation_key: str) -> None:
        super().__init__("lead write outcome is unknown")
        self.operation_key = operation_key


class LeadToolArgumentError(ValueError):
    def __init__(self, tool: str, reason: str) -> None:
        super().__init__(f"{tool}: {reason}")
        self.tool = tool
        self.reason = reason


def lead_operation_key(interaction_key: str, turn_key: str, tool: str, arguments: str) -> str:
    """Derived from the call and the accepted turn, so a retry replays its write."""

    digest = hashlib.sha256(
        "\0".join((interaction_key, turn_key, tool, arguments)).encode()
    ).hexdigest()[:40]
    return f"{tool}:{digest}"


@dataclass
class AcceptedTurns:
    """Final caller turns only. Provisional recognition never gets an identifier,
    so it can never be cited as the source of a saved value."""

    _count: int = 0
    _ids: list[str] = field(default_factory=list)
    _receipt_turn: str | None = None

    def accept(self) -> str:
        self._count += 1
        turn = f"turn-{self._count}"
        self._ids.append(turn)
        return turn

    @property
    def current(self) -> str | None:
        return self._ids[-1] if self._ids else None

    def contains(self, turn: str) -> bool:
        return turn in self._ids

    def record_receipt(self) -> None:
        self._receipt_turn = self.current

    def receipt_for_current_turn(self) -> bool:
        """Whether a committed lead write answers the caller's latest turn."""

        return self._receipt_turn is not None and self._receipt_turn == self.current


class VoiceLeadTools:
    """Build the voice lead tools for one call and run them against the store."""

    def __init__(
        self,
        *,
        store: LeadStore,
        schema: LeadFieldSchema,
        capabilities: Sequence[str],
        interaction_key: str,
        turns: AcceptedTurns,
        phone_region: Literal["IL"] | None = "IL",
        lead_id: str | None = None,
    ) -> None:
        self._store = store
        self._schema = schema
        self._capabilities = list(capabilities)
        self._interaction_key = interaction_key
        self._turns = turns
        self._phone_region = phone_region
        self.lead_id = lead_id
        self._resumed = lead_id is not None

    @property
    def descriptors(self) -> list[LeadToolDescriptor]:
        return lead_tool_descriptors(self._capabilities, self._schema)

    async def resume(self) -> dict | None:
        """Load the lead this call is linked to (e.g. the conversation that
        asked for it). Never a guess by phone number.

        A continued lead keeps the field schema it was opened with, so values
        are normalized against the questions that lead actually asks.
        """

        state = await self._store.capture_state(self.lead_id)
        self._resumed = True
        if state is not None:
            self.lead_id = str(state["lead"]["id"])
            schema = state.get("schema")
            if schema is not None:
                self._schema = parse_lead_field_schema(schema)
        return state

    async def _resume_once(self) -> None:
        if self._resumed:
            return
        try:
            await self.resume()
        except LeadStoreRefusal:
            # Not yet permitted (for example, identity still locked). The write
            # that follows asks the database again and is refused truthfully.
            self._resumed = False

    def _summary(self, state: dict | None) -> dict[str, Any]:
        fields = (state or {}).get("fields") or []
        return {
            "collected": [
                {"key": entry["key"], "state": entry["state"], "value": entry["normalizedValue"]}
                for entry in fields
            ],
            "missingRequired": lead_completeness(self._schema, fields)["missing"],
            "status": ((state or {}).get("lead") or {}).get("status", "new"),
        }

    def _observations(self, tool: str, arguments: Mapping[str, Any]) -> list[dict[str, Any]]:
        raw = arguments.get("observations")
        limit = CONTRACT["tools"]["maxObservationsPerCall"]
        if not isinstance(raw, list) or not raw:
            raise LeadToolArgumentError(tool, "at least one observation is required")
        if len(raw) > limit:
            raise LeadToolArgumentError(tool, f"at most {limit} observations may be sent at once")
        current = self._turns.current
        if current is None:
            raise LeadToolArgumentError(tool, "nothing the caller said has been accepted yet")
        observations: list[dict[str, Any]] = []
        for entry in raw:
            if not isinstance(entry, dict):
                raise LeadToolArgumentError(tool, "each observation must be an object")
            confirmed = entry.get("confirmed")
            if confirmed is not None and not isinstance(confirmed, bool):
                raise LeadToolArgumentError(tool, "confirmed must be true or false")
            cited = entry.get("sourceReference")
            # A cited turn counts only when this call really accepted it;
            # otherwise the value is attributed to the turn that carried the call.
            reference = cited if isinstance(cited, str) and self._turns.contains(cited) else current
            observation: dict[str, Any] = {
                "key": entry.get("key"),
                "state": entry.get("state"),
                "sourceReferenceId": reference,
                # A model asserting confirmation reaches customer_confirmed at
                # most; only a person in the workspace records human_verified.
                "confirmation": "customer_confirmed" if confirmed is True else "unconfirmed",
            }
            for name in ("value", "currency"):
                if isinstance(entry.get(name), str):
                    observation[name] = entry[name]
            observations.append(
                normalize_lead_field(self._schema, observation, phone_region=self._phone_region)
            )
        return observations

    async def _commit(
        self,
        operation_key: str,
        write: Callable[[], Awaitable[dict]],
        *,
        answers_caller: bool = True,
    ) -> dict:
        """Run a write; on an unknown outcome, reconcile before reporting.

        ``answers_caller`` is false for bookkeeping writes such as opening the
        lead: only the write that stores what the caller said licenses a
        spoken "saved".
        """

        try:
            result = await write()
        except LeadStoreRefusal:
            raise
        except Exception as error:
            # Timeout, dropped connection: the write may or may not have landed.
            # The operation key is the same one the write used, so the database
            # can say which. Only a found receipt is reported as saved.
            try:
                receipt = await self._store.operation_receipt(operation_key)
            except Exception:
                receipt = None
            if receipt is None:
                raise LeadOutcomeUnknown(operation_key) from error
            result = {"receipt": receipt, "rejected": []}
        if answers_caller:
            self._turns.record_receipt()
        return result

    async def run(self, tool: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
        """Execute one tool call and describe the truthful outcome to the model."""

        if tool not in {descriptor.name for descriptor in self.descriptors}:
            return {"ok": False, "error": "this action is not enabled for this agent"}
        turn = self._turns.current or "before-first-turn"
        canonical = json.dumps(arguments, ensure_ascii=False, sort_keys=True, default=str)
        operation_key = lead_operation_key(self._interaction_key, turn, tool, canonical)
        try:
            if tool == "lead_read_state":
                await self._resume_once()
                return {"ok": True, **self._summary(await self._store.capture_state(self.lead_id))}
            if tool == "lead_save_fields":
                if self._turns.current is None:
                    raise LeadToolArgumentError(
                        tool, "nothing the caller said has been accepted yet"
                    )
                # Before normalizing: a continued lead's own schema decides how
                # the caller's words are read.
                await self._resume_once()
                observations = self._observations(tool, arguments)
                if self.lead_id is None:
                    opening = f"{operation_key}:open"
                    created = await self._commit(
                        opening, lambda: self._store.ensure(opening), answers_caller=False
                    )
                    self.lead_id = str(created["receipt"]["leadId"])
                lead_id = self.lead_id
                result = await self._commit(
                    operation_key,
                    lambda: self._store.save_fields(lead_id, operation_key, observations),
                )
            elif tool == "lead_finalize_collection":
                summary = arguments.get("summary")
                if not isinstance(summary, str) or not trim(summary):
                    raise LeadToolArgumentError(tool, "summary is required")
                await self._resume_once()
                if self.lead_id is None:
                    return {"ok": False, "error": "nothing has been saved for this enquiry yet"}
                next_action = arguments.get("nextAction")
                lead_id = self.lead_id
                result = await self._commit(
                    operation_key,
                    lambda: self._store.finalize(
                        lead_id,
                        operation_key,
                        trim(summary),
                        trim(next_action) if isinstance(next_action, str) else None,
                    ),
                )
            else:
                note = arguments.get("note")
                if not isinstance(note, str) or not trim(note):
                    raise LeadToolArgumentError(tool, "note is required")
                await self._resume_once()
                if self.lead_id is None:
                    return {"ok": False, "error": "nothing has been saved for this enquiry yet"}
                due_at = arguments.get("dueAt")
                lead_id = self.lead_id
                result = await self._commit(
                    operation_key,
                    lambda: self._store.follow_up(
                        lead_id,
                        operation_key,
                        trim(note),
                        due_at if isinstance(due_at, str) and due_at.strip() else None,
                    ),
                )
        except LeadFieldValidationError as error:
            return {"ok": False, "error": f"{error.field}: {error.reason}", "field": error.field}
        except LeadToolArgumentError as error:
            return {"ok": False, "error": error.reason}
        except LeadStoreRefusal as error:
            return {"ok": False, "error": "the action was refused", "code": error.code}
        except LeadOutcomeUnknown:
            # Not a refusal and not a success. Retrying this same call in this
            # turn reuses the operation key, so it cannot write twice.
            return {
                "ok": False,
                "error": "the save could not be confirmed; do not tell the caller it was saved",
                "code": "outcome_unknown",
            }
        receipt = result["receipt"]
        state = await self._store.capture_state(self.lead_id)
        return {
            "ok": True,
            # The receipt is what makes "saved" true. Internal identifiers stay
            # out of the wording the model is asked to produce.
            "saved": True,
            "reference": receipt.get("reference"),
            "revision": receipt.get("revision"),
            "changed": receipt.get("changed", []),
            "rejected": [
                {"key": entry.get("key"), "reason": entry.get("reason")}
                for entry in result.get("rejected", [])
            ],
            **self._summary(state),
        }

    def functions(self, action_guard: Callable[..., Awaitable[Any]] | None = None) -> list:
        """Pipecat Flows functions that act without leaving the current node."""

        from pipecat.flows import FlowsFunctionSchema

        schemas = []
        for descriptor in self.descriptors:

            def bind(name: str) -> Callable[[dict, Any], Awaitable[tuple[dict, None]]]:
                async def execute(args: dict, _manager: Any) -> tuple[dict, None]:
                    return await self.run(name, args or {}), None

                async def handler(args: dict, manager: Any) -> tuple[dict, None]:
                    if action_guard is not None:
                        return await action_guard(execute, args, manager)
                    return await execute(args, manager)

                return handler

            schemas.append(
                FlowsFunctionSchema(
                    name=descriptor.name,
                    description=descriptor.description,
                    properties=descriptor.properties,
                    required=descriptor.required,
                    handler=bind(descriptor.name),
                    # A write is not cancelled by barge-in once it has started:
                    # the database decides whether it committed, and the result
                    # must reach the model either way.
                    cancel_on_interruption=False,
                )
            )
        return schemas
