from typing import Annotated

import phonenumbers
from pydantic import AfterValidator


def validate_e164(value: str, region: str | None = None) -> str:
    """Validate a phone number and return it canonicalised to E.164.

    Uses libphonenumber (`phonenumbers`) rather than a length/format regex, so a
    number that is well-formed but not actually dialable — a bad area code, wrong
    digit count for its country — is rejected here at the boundary instead of
    failing later as an un-routable SIP call. Parsing with `region=None` requires
    the `+<country code>` prefix, i.e. the number must already be E.164-shaped.

    `region` (e.g. "IL") additionally accepts that country's national form, which
    is what a spreadsheet actually contains: `050-123-4567`, `050 123 4567`,
    `00972…`. libphonenumber already knows every one of those conventions, so a
    campaign upload passes the region rather than growing its own normaliser.
    """
    try:
        parsed = phonenumbers.parse(value, region)
    except phonenumbers.NumberParseException as exc:
        raise ValueError(f"not a parseable phone number: {exc}") from exc
    if not phonenumbers.is_valid_number(parsed):
        raise ValueError(f"not a valid phone number: {value!r}")
    return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)


# A phone number proven valid and normalised to E.164 at construction time.
E164 = Annotated[str, AfterValidator(validate_e164)]
