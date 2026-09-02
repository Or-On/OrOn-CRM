"""Reading a contact list, and refusing to dial what it should not."""

import io

import pytest
from openpyxl import Workbook
from oron_sessions import contacts_file

CSV = """שם,טלפון,עיר
אלי כהן,0544567890,חיפה
נועה לוי,054-456-7891,תל אביב
דנה,+972523334444,ירושלים
"""


def _xlsx(rows: list[list]) -> bytes:
    wb = Workbook()
    sheet = wb.worksheets[0]
    for row in rows:
        sheet.append(row)
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def test_a_leading_zero_becomes_the_country_code():
    """The form every Israeli spreadsheet actually holds."""
    parsed = contacts_file.parse(CSV.encode(), "list.csv")
    contacts, rejected = contacts_file.to_contacts(parsed, "טלפון")

    assert [c.phone for c in contacts] == [
        "+972544567890",
        "+972544567891",
        "+972523334444",
    ]
    assert rejected == []


def test_separators_are_the_library_s_problem_not_ours():
    parsed = contacts_file.parse(b"phone\n054-456-7890\n054 456 7890\n00972544567890\n", "l.csv")
    contacts, _ = contacts_file.to_contacts(parsed, "phone")
    assert {c.phone for c in contacts} == {"+972544567890"}  # all one number, deduped


def test_the_rest_of_the_row_is_kept_for_the_flow_to_interpolate():
    parsed = contacts_file.parse(CSV.encode(), "list.csv")
    contacts, _ = contacts_file.to_contacts(parsed, "טלפון")
    assert contacts[0].data["שם"] == "אלי כהן"
    assert contacts[0].data["עיר"] == "חיפה"


def test_a_bad_number_is_reported_with_its_row_not_dropped():
    """A campaign that silently imports 2 of 3 numbers under-runs without saying
    so, and nobody finds out until the list is short."""
    # Row 4 has a name but no number — a real shape in an exported list, and the
    # one worth reporting. A trailing blank line is not a row and csv drops it.
    parsed = contacts_file.parse(b"phone,name\n0544567890,a\nnot-a-number,b\n,c\n", "l.csv")
    contacts, rejected = contacts_file.to_contacts(parsed, "phone")

    assert [c.phone for c in contacts] == ["+972544567890"]
    assert [(r.row, r.value) for r in rejected] == [(3, "not-a-number"), (4, "")]


def test_a_duplicate_is_rejected_rather_than_called_twice():
    parsed = contacts_file.parse(b"phone\n0544567890\n0544567890\n", "l.csv")
    contacts, rejected = contacts_file.to_contacts(parsed, "phone")
    assert len(contacts) == 1
    assert rejected[0].reason == "מספר כפול"


def test_an_unknown_column_names_what_the_file_actually_has():
    parsed = contacts_file.parse(CSV.encode(), "list.csv")
    with pytest.raises(ValueError, match="טלפון"):
        contacts_file.to_contacts(parsed, "phone")


def test_excel_bom_does_not_become_part_of_the_first_header():
    """Excel writes a UTF-8 BOM; decoded as plain utf-8 the first column is named
    '\\ufeffphone' and cannot be selected by the label the user can see."""
    parsed = contacts_file.parse("﻿phone,name\n0544567890,x\n".encode(), "l.csv")
    assert parsed.columns == ["phone", "name"]


def test_xlsx_numeric_cells_do_not_arrive_as_floats():
    """openpyxl types a numeric phone column as float: 972544567890 comes back
    as '972544567890.0', which is not a phone number."""
    content = _xlsx([["name", "phone"], ["אלי", 972544567890], ["נועה", "0544567891"]])
    parsed = contacts_file.parse(content, "list.xlsx")
    contacts, rejected = contacts_file.to_contacts(parsed, "phone")

    assert rejected == []
    assert [c.phone for c in contacts] == ["+972544567890", "+972544567891"]


def test_xlsx_blank_trailing_rows_are_not_contacts():
    content = _xlsx([["phone"], ["0544567890"], [None], [None]])
    parsed = contacts_file.parse(content, "list.xlsx")
    assert len(parsed.rows) == 1


def test_an_unsupported_file_type_is_refused_by_name():
    with pytest.raises(ValueError, match="csv"):
        contacts_file.parse(b"x", "contacts.pdf")


def test_the_phone_column_is_not_also_kept_in_the_row_data():
    """`data` is rendered verbatim by the console. Leaving the phone column in it
    puts the plaintext number on screen beside the masked one, which is the whole
    thing `phone_hint` exists to prevent."""
    parsed = contacts_file.parse(CSV.encode(), "list.csv")
    contacts, _ = contacts_file.to_contacts(parsed, "טלפון")

    assert "טלפון" not in contacts[0].data
    assert not any("0544567890" in v for v in contacts[0].data.values())
    assert contacts[0].data == {"שם": "אלי כהן", "עיר": "חיפה"}


def test_a_file_past_the_row_limit_is_refused_not_truncated():
    """Importing the first MAX_ROWS silently is worse than the dropped rows the
    rejection report exists to catch: nothing names the omitted tail, so the
    campaign dials a prefix of the list and looks complete doing it."""
    rows = "\n".join(f"05445{i:05d}" for i in range(contacts_file.MAX_ROWS + 1))
    with pytest.raises(ValueError, match=f"{contacts_file.MAX_ROWS:,}"):
        contacts_file.parse(f"phone\n{rows}\n".encode(), "big.csv")


def test_a_file_at_the_row_limit_is_still_accepted():
    rows = "\n".join(f"05445{i:05d}" for i in range(contacts_file.MAX_ROWS))
    parsed = contacts_file.parse(f"phone\n{rows}\n".encode(), "big.csv")
    assert len(parsed.rows) == contacts_file.MAX_ROWS
