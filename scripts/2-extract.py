"""Stage 2 — part PDFs to elector rows.

Streams each polling-part PDF, OCRs it in memory and appends the rows to
`cache/rows/<ac>.jsonl`. PDF bytes are never written to disk: at ~58,000 parts
averaging 5 MB that is over 200 GB of redundant storage, and only the rows are
worth keeping.

    python scripts/2-extract.py                     # everything in the manifest
    python scripts/2-extract.py --ac 24             # one constituency
    python scripts/2-extract.py --ac 24 --limit 5   # a taste of one
    python scripts/2-extract.py --local DIR         # OCR a directory of PDFs

Resumable. Every finished part is recorded in `cache/done/<ac>.txt` and skipped
on a re-run, because a statewide pass is measured in days and will be
interrupted.

Rows that fail validation are written with `"ok": false` rather than dropped.
That distinction is the whole point: a part we could not read must reduce
*coverage*, so the site withholds its verdict, and must never look like a part
whose electors simply are not there.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).parent / 'ocr'))
from roll_ocr import EPIC_RE, read_part_bytes  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(os.environ.get('ROLL_CACHE', ROOT / 'cache'))
ROWS = CACHE / 'rows'
DONE = CACHE / 'done'

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

# ECI serves every published part PDF from its own CDN at a deterministic path,
# with no captcha, no cookie and no session — verified byte-identical against a
# hand-downloaded copy of AC 196 part 227. The portal's captcha sits on
# `generate-published-pdfs`, which only returns this same path as a string; the
# file itself is public, so that call is skipped entirely.
CDN_BASE = 'https://voters.eci.gov.in/eroll'

# Kannada only. Both KAN and ENG are published for every AC, and OCR reads only
# the serial and the EPIC — pure ASCII in either — so the language costs nothing
# in accuracy. One language is chosen so a part has exactly one canonical
# source, and it is the Kannada roll because that is what the Karnataka voter is
# handed at the ERO counter when they contest an entry.
LANG = 'KAN'


def source_url(ac: int, part: int, lang: str = LANG) -> str:
    """Where a part PDF lives on the ECI CDN.

    2026/s10/sir-draftroll/196/2026-EROLLGEN-S10-196-SIR-DraftRoll-Revision1-KAN-227-WI.pdf

    Note the case split: the directory segments are lowercase and the filename
    segments are not, so this cannot be built from one casing of the roll name.
    """
    name = (f'2026-EROLLGEN-S10-{ac}-SIR-DraftRoll-Revision1-'
            f'{lang}-{part}-WI.pdf')
    return f'{CDN_BASE}/2026/s10/sir-draftroll/{ac}/{name}'


def fetch(url: str, tries: int = 3, timeout: int = 120) -> bytes | None:
    for attempt in range(tries):
        try:
            req = Request(url, headers={'User-Agent': UA})
            with urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            # A missing file comes back as an HTML error page, not a 404.
            return data if data[:5] == b'%PDF-' else None
        except Exception:
            if attempt < tries - 1:
                time.sleep(1.5 * (attempt + 1))
    return None


def do_part(job: dict) -> dict:
    """Fetch (or read) one part and OCR it. Runs in a worker process."""
    started = time.time()
    try:
        if job.get('path'):
            data = Path(job['path']).read_bytes()
        else:
            data = fetch(job['url'])
        if not data:
            return {**job, 'error': 'unreadable', 'rows': []}

        rows = read_part_bytes(data)
        out = [
            {'epic': r.epic, 'serial': r.serial, 'ac': job['ac'],
             'part': job['part'], 'partName': job.get('partName', ''),
             'ok': bool(r.ok and EPIC_RE.match(r.epic))}
            for r in rows
        ]
        return {**job, 'rows': out, 'secs': round(time.time() - started, 1)}
    except Exception as exc:
        return {**job, 'error': f'{type(exc).__name__}: {exc}', 'rows': []}


def load_jobs(args) -> list[dict]:
    if args.local:
        # A directory of already-downloaded PDFs, for calibration runs.
        return [
            {'ac': args.ac or 0, 'part': i + 1, 'partName': '', 'path': str(p), 'url': ''}
            for i, p in enumerate(sorted(Path(args.local).glob('*.pdf')))
        ]

    manifest = json.loads((CACHE / 'manifest.json').read_text('utf8'))
    jobs = []
    for ac in manifest['constituencies']:
        if args.ac and ac['acNumber'] != args.ac:
            continue
        for part in ac['parts']:
            jobs.append({
                'ac': ac['acNumber'],
                'part': part['partNumber'],
                'partName': part.get('partName', ''),
                'url': source_url(ac['acNumber'], part['partNumber']),
                'path': '',
            })
    return jobs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--ac', type=int)
    ap.add_argument('--limit', type=int)
    ap.add_argument('--local')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 4) - 1))
    args = ap.parse_args()

    ROWS.mkdir(parents=True, exist_ok=True)
    DONE.mkdir(parents=True, exist_ok=True)

    jobs = load_jobs(args)
    done: set[tuple[int, int]] = set()
    for ledger in DONE.glob('*.txt'):
        ac = int(ledger.stem)
        done |= {(ac, int(x)) for x in ledger.read_text('utf8').split() if x.strip()}
    jobs = [j for j in jobs if (j['ac'], j['part']) not in done]
    if args.limit:
        jobs = jobs[:args.limit]

    if not jobs:
        print('Nothing to do — every part in scope is already extracted.')
        return 0
    print(f'{len(jobs)} parts to read, {args.workers} workers')

    handles: dict[int, io.TextIOBase] = {}
    ledgers: dict[int, io.TextIOBase] = {}
    total_rows = unread = flagged = 0
    started = time.time()

    try:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(do_part, j): j for j in jobs}
            for n, fut in enumerate(as_completed(futures), 1):
                res = fut.result()
                ac = res['ac']
                if res.get('error'):
                    unread += 1
                    print(f"  [{n}/{len(jobs)}] AC{ac} part {res['part']}: {res['error']}")
                    continue
                if ac not in handles:
                    handles[ac] = (ROWS / f'{ac}.jsonl').open('a', encoding='utf8')
                    ledgers[ac] = (DONE / f'{ac}.txt').open('a', encoding='utf8')
                for row in res['rows']:
                    handles[ac].write(json.dumps(row, ensure_ascii=False) + '\n')
                    flagged += not row['ok']
                handles[ac].flush()
                ledgers[ac].write(f"{res['part']}\n")
                ledgers[ac].flush()
                total_rows += len(res['rows'])
                if n % 25 == 0 or n == len(jobs):
                    rate = n / max(1e-9, time.time() - started)
                    print(f'  [{n}/{len(jobs)}] {total_rows} rows, {unread} unreadable, '
                          f'{rate*60:.0f} parts/min')
    finally:
        for h in (*handles.values(), *ledgers.values()):
            h.close()

    pct = flagged / total_rows * 100 if total_rows else 0
    print(f'\n{total_rows} rows, {flagged} flagged low-confidence ({pct:.1f}%), '
          f'{unread} parts unreadable, in {(time.time()-started)/60:.1f} min')
    return 0


if __name__ == '__main__':
    sys.exit(main())
