"""Stage 17 — measure how often contact-sheet batching produces a
silently-wrong (but grammatically valid) EPIC, versus reading the same card
in isolation.

Background: found by manual user verification (2026-08-30) that
INA8000960 (published ok:true, i.e. fully confirmed by the pipeline's own
accuracy layers) is actually INA1800960 on the source PDF. Isolating that
exact card's crop and OCR'ing it alone reads 'INA1I800960' (11 chars, the
documented spurious-glyph pattern) -- and the pipeline's own coerce_epic(),
applied to THAT reading, correctly recovers INA1800960. The production
pipeline never gets that chance, because it batches all ~30 cards on a page
into one tall image for a single Tesseract pass (~10x faster, per the
README), and in that batched context this same card reads as INA8000960
directly -- already exactly 10 characters, so the 11-char spurious-glyph
fixer never triggers. Silently wrong, not silently uncertain.

This measures how common that is on a large statewide random sample -- not a
full statewide audit. Isolated OCR forfeits the ~10x batching speedup
(README: 0.9s for 30 cards batched vs 9.6s isolated, ~0.32s/card), so
isolating every card in ~100 full parts (~700 cards/part average) would run
upward of a day. Instead this samples a bounded number of cards *within*
each sampled part -- the same "samples per unit" shape already used by
scripts/14-exhaustive-sweep.mjs for per-booth sampling -- so the statewide
breadth (100+ parts, spread across ACs/districts) is real while the total
isolated-OCR call count stays tractable in one sitting.

    python scripts/ocr/measure_batching_error.py --parts 120 --cards-per-part 15

Per sampled card:
  - batched value = whatever scripts/2-extract-forever.mjs would actually
    publish for that row (read_part_bytes' own Row, unmodified production
    code path).
  - isolated value = that exact same crop, OCR'd completely alone, then
    coerce_epic()'d exactly as the batched path does.
  - SILENT_MISMATCH: both are grammar-valid (ok) and they disagree -- a
    confirmed instance of the same bug class as INA8000960.
  - RETRY_RECOVERABLE: batched failed grammar, isolated (post coerce_epic)
    passes -- the already-documented ROLL_OCR_RETRY finding, distinct bug.
  - AGREEMENT: both valid and identical.
  - BOTH_UNREADABLE: neither is grammar-valid.

Every SILENT_MISMATCH_CANDIDATE and RETRY_RECOVERABLE_CANDIDATE is logged
individually to test-logs/test-log.jsonl (layer: "ocr-batching-check"); one
SUMMARY line is logged per part with the aggregate counts, so the log book
carries both the detail and a reviewable total without a log line per
agreeing row (matching the precedent in 13-overlap-audit.mjs, which logs
found collisions, not every non-colliding comparison).

IMPORTANT — why every flag is a *candidate*, not a confirmed error: a dry
run on this script (2026-08-30, 3 parts) found isolating a single crop is
itself unreliable in both directions. AC218/part281/serial786's true value
(confirmed by eye against the source pixels) is YID4135927, matching the
production batched read exactly -- but isolating that same crop hallucinated
a spurious digit ("Y1ID4135927"), producing a false-positive mismatch flag.
Separately, re-testing the already-known-true INA8000960/INA1800960 case
(AC112/part202/serial476) found neither isolation method used here reliably
reproduces the correct answer on every run -- one gave an unparseable
12-char string, the other happened to coincide with the same wrong batched
value. So isolation has a real false-negative rate too. Net effect:
automated agreement/disagreement between batched and isolated OCR is only
a heuristic candidate screen, never a verdict either way. Every candidate's
crop image is saved to cache/ocr-batching-candidates/ specifically so a
human can look at the actual pixels before any count is reported as
confirmed -- see cache/ocr-batching-check-summary.json's "candidates" list
after a run, and review each PNG before trusting the headline number.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import roll_ocr  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
CACHE = ROOT / 'cache'
TEST_LOG = ROOT / 'test-logs' / 'test-log.jsonl'
CANDIDATES_DIR = CACHE / 'ocr-batching-candidates'

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
CDN = 'https://voters.eci.gov.in/eroll/2026/s10/sir-draftroll'


def source_url(ac: int, part: int) -> str:
    name = f'2026-EROLLGEN-S10-{ac}-SIR-DraftRoll-Revision1-KAN-{part}-WI.pdf'
    return f'{CDN}/{ac}/{name}'


def fetch(url: str, tries: int = 3, timeout: int = 60) -> bytes | None:
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            if data[:5] == b'%PDF-':
                return data
        except Exception:
            pass
        if attempt < tries - 1:
            time.sleep(1.5 * (attempt + 1))
    return None


def log_test(entry: dict) -> None:
    entry = {'timestamp': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'), **entry}
    TEST_LOG.parent.mkdir(parents=True, exist_ok=True)
    with TEST_LOG.open('a', encoding='utf8') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def extract_crops_in_order(doc) -> list:
    """Rebuild the same ordered list of (kept) EPIC crops that
    read_part_bytes builds internally, using the identical geometry code
    (find_grid / card_header / _ink_box / the same "keep only cards with a
    non-None epic crop" filter as roll_ocr.read_page_raw). Pure numpy/PIL,
    no OCR, so re-deriving it here (rather than reaching into
    read_page_raw's locals) costs nothing and needs no production-code
    changes.

    This is what lets isolated-OCR results be matched to the production
    Row list index-for-index: both walk pages in doc order and, within a
    page, bands then columns in the same order, applying the same keep
    filter, so crops[i] and read_part_bytes(data)[i] refer to the same card.
    """
    crops = []
    for img in roll_ocr._pages(doc):
        if img is None:
            continue
        im = img.convert('L')
        import numpy as np
        dark = np.array(im) < 128
        grid = roll_ocr.find_grid(dark)
        if grid is None:
            continue
        for band_top, _ in grid.bands:
            for left, right in grid.cols:
                _serial, epic = roll_ocr.card_header(im, dark, band_top, left, right)
                epic = roll_ocr._ink_box(epic)
                if epic is not None:
                    crops.append(epic)
    return crops


def isolate_read(crop) -> tuple[str, str]:
    """OCR one crop completely alone. Returns (raw, coerced)."""
    sheet = roll_ocr.contact_sheet([crop])
    if sheet is None:
        return '', ''
    lines = roll_ocr.ocr_lines(sheet)
    raw = lines[0] if lines else ''
    return raw, roll_ocr.coerce_epic(raw)


def check_part(ac: int, part: int, cards_per_part: int, rng: random.Random) -> dict:
    data = fetch(source_url(ac, part))
    if not data:
        return {'ac': ac, 'part': part, 'error': 'fetch failed', 'cards_sampled': 0}

    import fitz
    batched_rows = roll_ocr.read_part_bytes(data)
    crops = extract_crops_in_order(fitz.open(stream=data, filetype='pdf'))

    if len(crops) != len(batched_rows):
        return {
            'ac': ac, 'part': part, 'cards_sampled': 0,
            'error': f'alignment mismatch: {len(crops)} crops vs {len(batched_rows)} rows, skipped',
        }

    n = len(crops)
    if n == 0:
        return {'ac': ac, 'part': part, 'cards_sampled': 0, 'error': 'no cards found'}

    sample_idx = rng.sample(range(n), min(cards_per_part, n))

    silent_mismatch_candidates = 0
    retry_recoverable_candidates = 0
    agreements = 0
    both_unreadable = 0
    candidates = []

    for i in sample_idx:
        row = batched_rows[i]
        batched_epic, batched_ok = row.epic, row.ok
        iso_raw, iso_epic = isolate_read(crops[i])
        iso_ok = bool(roll_ocr.EPIC_RE.match(iso_epic))

        if batched_ok and iso_ok and batched_epic == iso_epic:
            agreements += 1
            continue
        if batched_ok and iso_ok and batched_epic != iso_epic:
            verdict = 'SILENT_MISMATCH_CANDIDATE'
            silent_mismatch_candidates += 1
        elif not batched_ok and iso_ok:
            verdict = 'RETRY_RECOVERABLE_CANDIDATE'
            retry_recoverable_candidates += 1
        else:
            both_unreadable += 1
            continue

        CANDIDATES_DIR.mkdir(parents=True, exist_ok=True)
        crop_path = CANDIDATES_DIR / f'{ac}-{part}-{row.serial}.png'
        crops[i].save(crop_path)
        candidates.append({'ac': ac, 'part': part, 'serial': row.serial,
                            'batched': batched_epic, 'isolated': iso_epic,
                            'verdict': verdict, 'crop': str(crop_path)})
        log_test({
            'dataset': 'roll', 'layer': 'ocr-batching-check',
            'ac': ac, 'part': part, 'serial': row.serial,
            'expected': None,
            'actual': {'batched': batched_epic, 'isolated': iso_epic, 'isolatedRaw': iso_raw,
                       'crop': str(crop_path)},
            'verdict': verdict,
            'reason': 'unreviewed automated candidate -- isolation itself has a measured false '
                      'positive/negative rate, see script docstring; needs a human look at the crop '
                      'before being counted as confirmed',
        })

    result = {
        'ac': ac, 'part': part, 'cards_sampled': len(sample_idx),
        'total_cards_in_part': n,
        'silent_mismatch_candidates': silent_mismatch_candidates,
        'retry_recoverable_candidates': retry_recoverable_candidates,
        'agreements': agreements,
        'both_unreadable': both_unreadable,
        'candidates': candidates,
    }
    log_test({
        'dataset': 'roll', 'layer': 'ocr-batching-check',
        'ac': ac, 'part': part,
        'expected': None, 'actual': result,
        'verdict': 'SUMMARY',
    })
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--parts', type=int, default=120)
    ap.add_argument('--cards-per-part', type=int, default=15)
    ap.add_argument('--seed', type=int, default=None)
    ap.add_argument('--out', default=str(ROOT / 'cache' / 'ocr-batching-check-summary.json'))
    ap.add_argument('--spread-acs', action='store_true',
                     help='Sample --parts/224 parts from EVERY AC (rounded up), instead of pure random '
                          'across all parts statewide -- guarantees every constituency is represented '
                          'rather than leaving it to chance (large ACs have more parts and would '
                          'otherwise dominate a pure random sample).')
    ap.add_argument('--parts-file', default=None,
                     help='Skip sampling entirely; retry the exact "AC PART" pairs listed one per line '
                          'in this file (e.g. parts that failed to fetch in a previous run).')
    args = ap.parse_args()

    manifest = json.loads((CACHE / 'manifest.json').read_text('utf8'))
    rng = random.Random(args.seed)

    if args.parts_file:
        sample = []
        for line in Path(args.parts_file).read_text('utf8').splitlines():
            line = line.strip()
            if not line:
                continue
            ac, part = line.split()
            sample.append((int(ac), int(part)))
        print(f'{len(sample)} parts loaded from {args.parts_file} for retry.', flush=True)
    elif args.spread_acs:
        acs = manifest['constituencies']
        per_ac = max(1, round(args.parts / len(acs)))
        sample = []
        for ac in acs:
            parts = [(ac['acNumber'], p['partNumber']) for p in ac['parts']]
            sample.extend(rng.sample(parts, min(per_ac, len(parts))))
        rng.shuffle(sample)
        print(f'{len(sample)} parts sampled, spread {per_ac}/AC across all {len(acs)} constituencies.', flush=True)
    else:
        universe = []
        for ac in manifest['constituencies']:
            for part in ac['parts']:
                universe.append((ac['acNumber'], part['partNumber']))
        sample = rng.sample(universe, min(args.parts, len(universe)))
        print(f'{len(sample)} parts sampled statewide, out of {len(universe)} total parts.', flush=True)
    print(f'Up to {args.cards_per_part} isolated cards per part.', flush=True)

    totals = {'silent_mismatch_candidates': 0, 'retry_recoverable_candidates': 0, 'agreements': 0,
              'both_unreadable': 0, 'cards_sampled': 0, 'parts_ok': 0, 'parts_failed': 0}
    per_part = []
    all_candidates = []
    started = time.time()

    for n, (ac, part) in enumerate(sample, 1):
        result = check_part(ac, part, args.cards_per_part, rng)
        per_part.append(result)
        if result.get('error'):
            totals['parts_failed'] += 1
            print(f'[{n}/{len(sample)}] AC{ac}/part{part}: {result["error"]}', flush=True)
        else:
            totals['parts_ok'] += 1
            for k in ('silent_mismatch_candidates', 'retry_recoverable_candidates', 'agreements',
                      'both_unreadable', 'cards_sampled'):
                totals[k] += result[k]
            all_candidates.extend(result['candidates'])
            elapsed = time.time() - started
            print(f'[{n}/{len(sample)}] AC{ac}/part{part}: sampled {result["cards_sampled"]}/{result["total_cards_in_part"]} '
                  f'cards, {result["silent_mismatch_candidates"]} mismatch candidate(s), '
                  f'{result["retry_recoverable_candidates"]} retry-recoverable candidate(s)  '
                  f'(running totals: {totals["silent_mismatch_candidates"]} candidates / {totals["cards_sampled"]} cards, '
                  f'{elapsed:.0f}s elapsed)', flush=True)

        Path(args.out).write_text(
            json.dumps({'totals': totals, 'candidates': all_candidates, 'perPart': per_part}, indent=2), 'utf8')

    rate = (totals['silent_mismatch_candidates'] / totals['cards_sampled'] * 100) if totals['cards_sampled'] else 0.0
    print('\n=== done ===')
    print(f"Sampled {totals['cards_sampled']} cards across {totals['parts_ok']} parts "
          f"({totals['parts_failed']} parts failed to fetch/align).")
    print(f"RAW (unreviewed) silent-mismatch candidates: {totals['silent_mismatch_candidates']}  "
          f"({rate:.3f}% of sampled cards) -- NOT a confirmed error rate, see script docstring.")
    print(f"Retry-recoverable candidates (separate, already-known bug): {totals['retry_recoverable_candidates']}")
    print(f"Agreements: {totals['agreements']}   Both unreadable: {totals['both_unreadable']}")
    print(f"{len(all_candidates)} candidate crop image(s) saved under {CANDIDATES_DIR} for manual review.")
    print(f'Full detail written to {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
