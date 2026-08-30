"""Read ASD ("uncollectable elector") report PDFs.

Unlike the draft roll, these carry a real text layer — no OCR. See
OBSERVATIONS-ASD.md for the full derivation of every choice made here; this
module is the implementation of that document's section 4, and should not
diverge from it without updating both.

Load-bearing lessons from that document, restated here because getting any one
of them wrong silently corrupts data rather than raising:

  1. PyMuPDF is not thread-safe. Callers MUST run this under a process pool,
     never a thread pool — threads return corrupt rows from correct bytes with
     no error.
  2. Do not use page.find_tables(). Cells are binned against the page's own
     vector rules instead — faster and strictly more accurate (see doc §4.2).
  3. The EPIC cell wraps onto a second line in ~46% of rows. Fragments are
     joined by string concatenation, never parsed as int first (a leading
     zero would be lost), and the split point is not assumed to fall at any
     fixed position.
  4. The EPIC grammar here is [A-Z]{3}[0-9]{7,8} — one AC issues a genuine
     11-character series. This grammar is used to VALIDATE, never to coerce:
     unlike the roll's OCR pipeline, this text is exact, so "fixing" it up
     against the grammar would corrupt correct data instead of correcting a
     misread.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

import fitz  # PyMuPDF

EPIC_RE = re.compile(r'^[A-Z]{3}[0-9]{7,8}$')

# Column order in every ASD report, left to right (doc §2).
COL_SERIAL, COL_EPIC, COL_NAME, COL_RELATION, COL_RELATIVE, \
    COL_OLD_PART, COL_OLD_SERIAL, COL_AGE, COL_SEX, COL_REASON = range(10)
N_COLS = 10

# Substring-matched against the raw (line-wrap-variable) Kannada reason text.
# Order matters only in that the first match wins; the four are disjoint in
# practice. Store the code, never the raw string (doc §2).
#
# NFC-normalized at load time (and every lookup is normalized the same way)
# because several Kannada vowel signs — 'ೇ' among them — have both a single
# precomposed codepoint and a base+combining-mark decomposition that render
# identically but do not compare equal as raw strings. A hand-typed literal
# here and PyMuPDF's extracted text landed on different forms of the same
# glyph, which silently misclassified ~5.5% of DUPLICATE rows as OTHER before
# this was caught by cross-checking against the observations doc's own
# expected statewide reason-code mix (verified 2026-08-30).
REASON_CODES = [
    (code, unicodedata.normalize('NFC', needle)) for code, needle in [
        ('SHIFTED', 'ಖಾಯಂ ಸ್ಥಳಾಂತರ'),
        ('ABSENT', 'ಪತ್ತೆಯಾಗಿರುವುದಿಲ್ಲ'),
        ('ABSENT', 'ವಾಸ ಸ್ಥಳದಲ್ಲಿ ಇರುವುದಿಲ್ಲ'),
        ('DEAD', 'ಮರಣ'),
        ('DUPLICATE', 'ಹೆಸರು ಈಗಾಗಲೇ ನೋಂದಾಯಿಸಲ್ಪಟ್ಟಿದೆ'),
    ]
]


def reason_code(raw: str) -> str:
    normalized = unicodedata.normalize('NFC', raw)
    for code, needle in REASON_CODES:
        if needle in normalized:
            return code
    return 'OTHER'


@dataclass
class AsdRow:
    serial: int          # ಕ್ರ.ಸಂ. — serial within this report, not the roll
    epic: str
    name: str
    relation: str
    relativeName: str
    oldPart: int
    oldSerial: int
    age: int
    sex: str
    reasonCode: str
    reasonRaw: str
    ok: bool             # well-formed EPIC + all-numeric fields parsed cleanly


@dataclass
class AsdPage:
    acName: str
    partNo: int | None
    partName: str


def _cluster(values: list[float], tol: float = 2.0) -> list[float]:
    """Collapse near-duplicate coordinates from page.get_drawings() into one
    rule position per real line, at ~2pt tolerance (doc §4.2)."""
    if not values:
        return []
    values = sorted(values)
    clusters = [[values[0]]]
    for v in values[1:]:
        if v - clusters[-1][-1] <= tol:
            clusters[-1].append(v)
        else:
            clusters.append([v])
    return [sum(c) / len(c) for c in clusters]


def _grid_rules(page: fitz.Page) -> tuple[list[float], list[float]]:
    """Vertical and horizontal rule positions, derived from the page's own
    vector drawings — never from find_tables() (doc §4.2)."""
    xs: list[float] = []
    ys: list[float] = []
    for d in page.get_drawings():
        rect = d.get('rect')
        items = d.get('items', [])
        # A ruled line is either an explicit line item or a thin filled rect.
        for kind, *pts in items:
            if kind == 'l':  # line: p1, p2
                p1, p2 = pts
                if abs(p1.x - p2.x) < 1.0:
                    xs.append((p1.x + p2.x) / 2)
                elif abs(p1.y - p2.y) < 1.0:
                    ys.append((p1.y + p2.y) / 2)
            elif kind == 're':  # rect item
                r = pts[0]
                if r.width < 1.5 and r.height > 3:
                    xs.append((r.x0 + r.x1) / 2)
                elif r.height < 1.5 and r.width > 3:
                    ys.append((r.y0 + r.y1) / 2)
        if rect and rect.width < 1.5 and rect.height > 3:
            xs.append((rect.x0 + rect.x1) / 2)
        elif rect and rect.height < 1.5 and rect.width > 3:
            ys.append((rect.y0 + rect.y1) / 2)
    return _cluster(xs), _cluster(ys)


def _band_index(v: float, edges: list[float]) -> int | None:
    for i in range(len(edges) - 1):
        if edges[i] - 1.0 <= v <= edges[i + 1] + 1.0:
            return i
    return None


def _header_info(page: fitz.Page) -> AsdPage:
    """Page 1 carries the AC name and the booth number/name as plain text —
    a correct source for partName that the existing pipeline lacks
    (OBSERVATIONS-ASD.md §2, and HANDOFF.md §2's open item)."""
    # The first two lines are always "<AC label>: <acNo> - <acName>" and
    # "<part label>: <partNo> - <partName>", in that order — matched by
    # structure (":  N  - text"), not by hand-transcribing the Kannada label
    # text itself, which is fragile across the script's own conjunct glyphs.
    lines = page.get_text().split('\n')
    ac_name = ''
    part_no = None
    part_name = ''
    if len(lines) > 0:
        m = re.search(r':\s*([0-9]+)\s*-\s*(.+)$', lines[0])
        if m:
            ac_name = m.group(2).strip()
    if len(lines) > 1:
        m = re.search(r':\s*([0-9]+)\s*-\s*(.+)$', lines[1])
        if m:
            part_no = int(m.group(1))
            part_name = m.group(2).strip()
    return AsdPage(acName=ac_name, partNo=part_no, partName=part_name)


def _parse_int(s: str) -> int | None:
    try:
        return int(re.sub(r'[^0-9]', '', s))
    except ValueError:
        return None


def read_asd_bytes(data: bytes) -> tuple[list[AsdRow], AsdPage]:
    """Parse one ASD report PDF. Returns (rows, page-1 header info).

    A report with zero rows (every booth's electors were all collected) is a
    valid, successful read — return an empty list, not an error."""
    doc = fitz.open(stream=data, filetype='pdf')
    try:
        header = _header_info(doc[0]) if len(doc) else AsdPage('', None, '')
        rows: list[AsdRow] = []
        for page in doc:
            xs, ys = _grid_rules(page)
            if len(xs) < 11 or len(ys) < 2:
                continue  # page carries no data grid (cover/footer page)

            words = page.get_text('words')  # (x0, y0, x1, y1, text, block, line, word)
            cells: dict[tuple[int, int], list[tuple[float, float, str]]] = {}
            for x0, y0, x1, y1, wtext, *_ in words:
                cx = (x0 + x1) / 2
                cy = (y0 + y1) / 2
                col = _band_index(cx, xs)
                row = _band_index(cy, ys)
                if col is None or row is None:
                    continue
                cells.setdefault((row, col), []).append((round(cy, 1), x0, wtext))

            row_indices = sorted({r for r, _ in cells if r >= 0})
            for r in row_indices:
                cellvals = []
                for c in range(N_COLS):
                    frags = sorted(cells.get((r, c), []))
                    if c == COL_EPIC:
                        # String concatenation only — never parse a fragment as
                        # int first, or a leading zero silently disappears.
                        cellvals.append(''.join(f[2] for f in frags))
                    else:
                        cellvals.append(' '.join(f[2] for f in frags))

                if not any(cellvals):
                    continue

                epic = cellvals[COL_EPIC].strip().upper()
                serial = _parse_int(cellvals[COL_SERIAL])
                if serial is None:
                    # The column header repeats as its own "row" on every page
                    # (page.get_drawings() sees the same grid there) — its
                    # serial cell holds the Kannada header text, not a number.
                    # That is how it is told apart from a genuine data row.
                    continue
                old_part = _parse_int(cellvals[COL_OLD_PART])
                old_serial = _parse_int(cellvals[COL_OLD_SERIAL])
                age = _parse_int(cellvals[COL_AGE])
                reason_raw = cellvals[COL_REASON]

                ok = bool(
                    EPIC_RE.match(epic) and serial is not None
                    and old_part is not None and old_serial is not None and age is not None
                )
                rows.append(AsdRow(
                    serial=serial or 0,
                    epic=epic,
                    name=cellvals[COL_NAME].strip(),
                    relation=cellvals[COL_RELATION].strip(),
                    relativeName=cellvals[COL_RELATIVE].strip(),
                    oldPart=old_part or 0,
                    oldSerial=old_serial or 0,
                    age=age or 0,
                    sex=cellvals[COL_SEX].strip(),
                    reasonCode=reason_code(reason_raw),
                    reasonRaw=reason_raw.strip(),
                    ok=ok
                ))
        return rows, header
    finally:
        doc.close()
