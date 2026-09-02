import pytest
from oron_common import E164, validate_e164
from pydantic import BaseModel, ValidationError


def test_valid_number_is_normalised_to_e164():
    assert validate_e164("+1 415-555-0100") == "+14155550100"
    assert validate_e164("+972 3-555-0000") == "+97235550000"


def test_wellformed_but_invalid_number_is_rejected():
    # +1 555-123-4567: correct shape, but 555 is not a real US area code.
    with pytest.raises(ValueError, match="not a valid phone number"):
        validate_e164("+15551234567")


def test_unparseable_number_is_rejected():
    with pytest.raises(ValueError, match="not a parseable phone number"):
        validate_e164("+000")


def test_number_without_country_code_is_rejected():
    # region=None means the +country-code prefix is mandatory (i.e. must be E.164).
    with pytest.raises(ValueError):
        validate_e164("4155550100")


class _M(BaseModel):
    number: E164


def test_e164_type_validates_on_a_model_and_normalises():
    assert _M(number="+1 415 555 0100").number == "+14155550100"
    with pytest.raises(ValidationError):
        _M(number="+15551234567")
