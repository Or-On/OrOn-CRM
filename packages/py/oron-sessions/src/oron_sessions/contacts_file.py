"""Read a contact list out of a CSV or XLSX upload.

Parsing lives server-side so the PII handling has one home: the file is turned
into rows, the numbers are validated and encrypted, and nothing is written until
both succeed.

There is no attempt to guess which column holds the phone number. A header can
be `phone`, `טלפון`, `Mobile`, or `נייד 2`, and a heuristic that is right most of
the time is a heuristic that silently dials the wrong column the rest of it. The
caller previews the file, sees the headers, and names the column.
"""

import csv
import io

from oron_common import validate_e164
from pydantic import BaseModel

MAX_ROWS = 50_000
"""A guard on the upload, not a product limit. A spreadsheet with a million rows
is a mistake, and finding out by exhausting memory is the expensive way."""


class ParsedFile(BaseModel):
    columns: list[str]
    rows: list[dict[str, str]]


class ContactRow(BaseModel):
    phone: str
    data: dict[str, str]


class RejectedRow(BaseModel):
    """A row that will not be dialled, and why. Returned rather than dropped:
    silently discarding 40 of 500 numbers is how a campaign quietly under-runs."""

    row: int
    value: str
    reason: str
    data: dict[str, str] = {}
    """The rest of the spreadsheet row. Carried back so the number can be
    corrected in place without losing who it belonged to — without this, fixing
    a row in the console would import a phone number with no name against it."""


def check_supported(filename: str) -> None:
    if not filename.lower().endswith((".csv", ".xlsx")):
        raise ValueError(f"unsupported file type: {filename!r} — upload a .csv or .xlsx")


def _refuse_if_too_long(rows: list) -> None:
    """Refuse an oversized file rather than importing its first `MAX_ROWS`.

    Truncating silently is the same failure the rejected-rows report exists to
    prevent, only worse: nothing names the omitted tail, so the campaign dials a
    prefix of the list and looks complete doing it.
    """
    if len(rows) > MAX_ROWS:
        raise ValueError(f"יותר מ־{MAX_ROWS:,} שורות — יש לפצל את הקובץ")


def parse(content: bytes, filename: str) -> ParsedFile:
    check_supported(filename)
    return _parse_csv(content) if filename.lower().endswith(".csv") else _parse_xlsx(content)


def _parse_csv(content: bytes) -> ParsedFile:
    # utf-8-sig, not utf-8: Excel writes a BOM, which otherwise becomes part of
    # the first header name and makes that column unselectable by its own label.
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    columns = [c.strip() for c in (reader.fieldnames or []) if c and c.strip()]
    rows: list[dict[str, str]] = []
    for row in reader:
        rows.append({k.strip(): _text(v) for k, v in row.items() if k and k.strip()})
        _refuse_if_too_long(rows)
    return ParsedFile(columns=columns, rows=rows)


def _parse_xlsx(content: bytes) -> ParsedFile:
    # Imported here, not at module scope: openpyxl is only needed by an upload,
    # and the sessions API answers a great many requests that are not one.
    from openpyxl import load_workbook

    # read_only + data_only: stream rather than build the whole object graph, and
    # take the cached value of a formula rather than the formula text — a phone
    # column produced by CONCAT would otherwise arrive as "=CONCAT(...)".
    workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    try:
        sheet = workbook.worksheets[0]
        rows_iter = sheet.iter_rows(values_only=True)
        header = next(rows_iter, None)
        if header is None:
            return ParsedFile(columns=[], rows=[])
        columns = [_text(c) for c in header]
        # Trailing unnamed columns are Excel's, not the author's.
        while columns and not columns[-1]:
            columns.pop()

        rows: list[dict[str, str]] = []
        for values in rows_iter:
            row = {col: _text(v) for col, v in zip(columns, values, strict=False) if col}
            if any(row.values()):  # skip the blank rows Excel leaves behind
                rows.append(row)
                _refuse_if_too_long(rows)
        return ParsedFile(columns=columns, rows=rows)
    finally:
        workbook.close()


def _text(value: object) -> str:
    """Cell -> string, without scientific notation or a stray `.0`.

    openpyxl types a numeric-looking phone column as float, so `972501234567`
    comes back as `972501234567.0` and, past 15 digits, as `9.72501234567e+11`.
    Both are unusable as phone numbers.
    """
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def to_contacts(
    parsed: ParsedFile, phone_column: str, *, default_region: str = "IL"
) -> tuple[list[ContactRow], list[RejectedRow]]:
    """Split the parsed rows into dialable contacts and rejects."""
    if phone_column not in parsed.columns:
        raise ValueError(f"no column named {phone_column!r}; file has {parsed.columns}")

    return normalize(
        [
            # Row 1 is the header. The phone column is dropped from `data`: it is
            # stored encrypted in its own column, and kept here it would be
            # plaintext in a JSONB the list view renders — exactly what
            # `phone_hint` exists to prevent.
            (
                index,
                (row.get(phone_column) or "").strip(),
                {k: v for k, v in row.items() if v and k != phone_column},
            )
            for index, row in enumerate(parsed.rows, start=2)
        ],
        default_region=default_region,
    )


def normalize(
    rows: list[tuple[int, str, dict[str, str]]], *, default_region: str = "IL"
) -> tuple[list[ContactRow], list[RejectedRow]]:
    """Validate `(row number, raw phone, row data)` triples into contacts and
    rejects.

    Every number is normalised to E.164 here, at the edge, so nothing downstream
    has to wonder whether `050-123-4567` and `+972501234567` are the same person
    — and the dialer never receives a string it cannot dial.

    Shared by the file upload and by a row corrected in the console, so a fix
    typed into the browser is judged by exactly the rule that rejected it.
    """
    contacts: list[ContactRow] = []
    rejected: list[RejectedRow] = []
    seen: set[str] = set()

    for index, raw, data in rows:
        if not raw:
            rejected.append(RejectedRow(row=index, value="", reason="אין מספר טלפון", data=data))
            continue
        try:
            # The region is what lets libphonenumber accept `050-123-4567`; no
            # separator-stripping or leading-zero rule of our own.
            e164 = validate_e164(raw, default_region)
        except ValueError:
            # libphonenumber's own text is English and names its parser; the
            # row and the value already say which cell to go fix.
            rejected.append(RejectedRow(row=index, value=raw, reason="מספר לא תקין", data=data))
            continue
        if e164 in seen:
            # Calling the same person twice in one campaign is never intended,
            # and a duplicate is normal in an exported spreadsheet.
            rejected.append(RejectedRow(row=index, value=raw, reason="מספר כפול", data=data))
            continue
        seen.add(e164)
        contacts.append(ContactRow(phone=e164, data=data))

    return contacts, rejected
