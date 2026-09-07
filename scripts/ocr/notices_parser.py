"""Parser for the CEO's "notices issued" PDFs (discrepancy / no-mapping lists).

Sibling of `asd_parser.py`, not a variant of it: a third, independent
dataset, with its own storage (`cache/notices-rows/`) that must never mix
with the roll's or ASD's rows (same isolation rule as ASD's own module
docstring states, and for the same reason).

Real text layer, no OCR — same as ASD. The complication here is not the OCR
layer, it is that this dataset is 34 independently-uploaded Google Drive
trees, not one CDN, and at least two genuinely different PDF templates (plus
at least 3 filename conventions and inconsistent folder depths — see
HANDOFF.md's "notices feature" section) are already known to coexist. This
module is written to keep growing the template list rather than assume it
has seen the last one: anything that does not match a known template is
returned with `template=None` and zero rows, for the caller to record as
"unresolved" rather than silently drop.

Template A — the common case, seen across every district sampled so far
except one AC of BBMP Central. Page 1 carries a real header:
    AC No and Name: 195 - Belur
    Part No and Name: 139 - Government Lower Primary School, Gotravalli
followed by a table: S.No | Part Serial Number | EPIC Number | Elector Name |
Age | Gender | Reason for discrepancy.

Template B — seen so far only in BBMP Central's AC 163. No header at all;
AC/part must come from the filename (`S10_{ac}_{part}_...pdf`) or the
Drive folder path. Table: S.No. | Serial No. | EPIC Number | Elector Name |
Relative Details | Mapping Category | DOB/Age | Photo Uploaded.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

EPIC_RE = re.compile(r'^[A-Z]{3}[0-9]{7,8}$')
INT_RE = re.compile(r'^\d+$')
DOB_RE = re.compile(r'^\d{2}/\d{2}/\d{4}$')

HEADER_AC_RE = re.compile(r'AC No and Name:\s*(\d+)')
HEADER_PART_RE = re.compile(r'Part No and Name:\s*(\d+)')

# discrepency_2026_s10_SR_FORM_161_discrepency_elector_report_ac161_part42.pdf
# (or "...part42 (1).pdf" on a Drive re-upload)
FILENAME_RE_A = re.compile(r'ac(\d+)_part(\d+)(?:\s*\(\d+\))?\.pdf$', re.IGNORECASE)
# S10_163_100_KARNATAKA VIDYA SHALA...pdf
FILENAME_RE_B = re.compile(r'^S10_(\d+)_(\d+)_', re.IGNORECASE)
# A Drive folder named "163-Shantinagar" or "154 - Rajarajeshwarinagar" — AC
# only, no part; used as a last resort and only ever narrows which AC a file
# belongs to, never which part.
FOLDER_AC_RE = re.compile(r'^(\d+)\s*[-\s]')


@dataclass
class NoticeRow:
    serial: int
    epic: str
    name: str
    reason: str
    age: int | None = None
    gender: str | None = None


def identify_ac_part(full_text: str, filename: str, folder_path: list[str]) -> tuple[int | None, int | None, str]:
    """Returns (ac, part, method). `method` says which signal supplied the
    answer, so a caller building coverage stats can tell "confidently read
    off the document itself" apart from "guessed from a folder name" —
    the same honesty this project applies everywhere else (never claim a
    number is more certain than the evidence for it)."""
    ac_m = HEADER_AC_RE.search(full_text)
    part_m = HEADER_PART_RE.search(full_text)
    if ac_m and part_m:
        return int(ac_m.group(1)), int(part_m.group(1)), 'header'

    m = FILENAME_RE_A.search(filename) or FILENAME_RE_B.search(filename)
    if m:
        return int(m.group(1)), int(m.group(2)), 'filename'

    for name in reversed(folder_path):
        m = FOLDER_AC_RE.match(name.strip())
        if m:
            return int(m.group(1)), None, 'folder-ac-only'

    return None, None, 'unresolved'


def detect_template(full_text: str) -> str | None:
    if 'Reason for' in full_text and 'discrepancy' in full_text.lower():
        return 'A'
    if 'Mapping' in full_text and 'Category' in full_text and 'Relative Details' in full_text:
        return 'B'
    return None


def _tokens(full_text: str) -> list[str]:
    return [t.strip() for t in full_text.split('\n') if t.strip()]


def _is_row_anchor(tokens: list[str], i: int) -> bool:
    """S.No and Serial No are both plain integers, immediately followed by
    an EPIC — three tokens in a row with that shape essentially never occurs
    by chance inside free-text name/reason cells, so it is a safe place to
    anchor a new row without needing fixed column widths (cell text wraps
    unpredictably — see the module docstring's Template A example)."""
    return (
        i + 2 < len(tokens)
        and INT_RE.match(tokens[i])
        and INT_RE.match(tokens[i + 1])
        and bool(EPIC_RE.match(tokens[i + 2]))
    )


def parse_template_a(full_text: str) -> list[NoticeRow]:
    tokens = _tokens(full_text)
    rows: list[NoticeRow] = []
    i = 0
    n = len(tokens)
    while i < n:
        if not _is_row_anchor(tokens, i):
            i += 1
            continue
        serial = int(tokens[i + 1])
        epic = tokens[i + 2]
        i += 3
        name_parts = []
        age = gender = None
        while i < n:
            # The header row ("S.No", "Part Serial Number", ...) repeats at
            # every page break, mid-table — a real PDF confirmed this
            # directly (AC121 part4, serial 188's own reason text was found
            # concatenated with a full repeated header before this fix).
            # "S.No" never appears in real name/reason text, so it is a safe,
            # exact marker to bail on rather than swallowing the header into
            # whichever field was being consumed when the page turned.
            if tokens[i] == 'S.No':
                break
            if INT_RE.match(tokens[i]) and i + 1 < n and tokens[i + 1] in ('M', 'F'):
                age = int(tokens[i])
                gender = tokens[i + 1]
                i += 2
                break
            if _is_row_anchor(tokens, i):
                break  # malformed row (no age/gender found) — bail without consuming the next anchor
            name_parts.append(tokens[i])
            i += 1
        name = ' '.join(name_parts).strip()
        reason_parts = []
        while i < n and not _is_row_anchor(tokens, i) and tokens[i] != 'S.No':
            reason_parts.append(tokens[i])
            i += 1
        reason = ' '.join(reason_parts).strip()
        rows.append(NoticeRow(serial=serial, epic=epic, name=name, reason=reason, age=age, gender=gender))
        # Skip the repeated header block itself so the outer loop does not
        # waste time re-scanning it one token at a time before finding the
        # next real anchor — harmless if there is no header here (skips 0).
        while i < n and tokens[i] in ('S.No', 'Part Serial Number', 'EPIC Number', 'Elector Name',
                                       'Age', 'Gender', 'Reason for', 'discrepancy'):
            i += 1
    return rows


def parse_template_b(full_text: str) -> list[NoticeRow]:
    tokens = _tokens(full_text)
    rows: list[NoticeRow] = []
    i = 0
    n = len(tokens)
    while i < n:
        if not _is_row_anchor(tokens, i):
            i += 1
            continue
        serial = int(tokens[i + 1])
        epic = tokens[i + 2]
        i += 3
        blob_parts = []
        category = None
        while i < n:
            # Same page-break header repeat as Template A (see its own
            # comment) — this template's header starts "S.No." (with the
            # period), not Template A's "S.No". Not confirmed on a real
            # multi-page Template B file the way Template A's case was, but
            # AC163 (194 rows, so certainly multi-page) uses this template,
            # and the failure mode is structurally identical, so guarded the
            # same way rather than waiting to find it broken live too.
            if tokens[i] == 'S.No.':
                break
            if DOB_RE.match(tokens[i]):
                i += 1  # DOB itself is not stored — age (if present) is more useful and is the row's next token
                if i < n and re.match(r'^\(\d+\)$', tokens[i]):
                    i += 1  # "(49)" — age in parens, informational only, not parsed out separately here
                if i < n and tokens[i] in ('Yes', 'No'):
                    i += 1  # photo-uploaded flag — not carried into NoticeRow, not useful for search
                break
            if _is_row_anchor(tokens, i):
                break
            blob_parts.append(tokens[i])
            i += 1
        # The mapping category (e.g. "NO MAPPING") is typically the last
        # segment of the blob, immediately before the DOB — split it off
        # when recognisable, otherwise keep the whole blob as the reason
        # rather than guess where name ends and category begins.
        if blob_parts and blob_parts[-1].isupper() and len(blob_parts[-1]) > 2:
            category = blob_parts.pop()
        name = ' '.join(blob_parts).strip()
        rows.append(NoticeRow(serial=serial, epic=epic, name=name, reason=category or ''))
        while i < n and tokens[i] in ('S.No.', 'Serial', 'No.', 'EPIC', 'Number', 'Elector Name',
                                       'Relative Details', 'Mapping', 'Category', 'DOB/Age',
                                       'Photo', 'Uploaded'):
            i += 1
    return rows


def read_notices_pdf(data: bytes, filename: str, folder_path: list[str]):
    """Returns (ac, part, method, template, rows). `template` is None and
    `rows` is empty when nothing recognisable was found — the caller records
    this file as unresolved rather than pretending it was read."""
    import fitz

    doc = fitz.open(stream=data, filetype='pdf')
    full_text = '\n'.join(page.get_text() for page in doc)

    ac, part, method = identify_ac_part(full_text, filename, folder_path)
    template = detect_template(full_text)
    if template is None or ac is None or part is None:
        return ac, part, method, template, []

    rows = parse_template_a(full_text) if template == 'A' else parse_template_b(full_text)
    return ac, part, method, template, rows
