"""Stage 9 — ASD ("uncollectable elector") report PDFs to rows.

Sibling of `2-extract.py`, not a variant of it — deliberately kept as a
separate script writing to separate paths, per OBSERVATIONS-ASD.md's storage
design: this dataset is never mixed with the draft roll's own rows or done
ledger, on disk or in memory, at any stage.

    python scripts/9-extract-asd.py                  # everything in the manifest
    python scripts/9-extract-asd.py --ac 24           # one constituency
    python scripts/9-extract-asd.py --ac 24 --limit 5 # a taste of one

Resumable exactly like stage 2: every finished part is recorded in
`cache/asd-done/<ac>.txt` and skipped on a re-run.

These PDFs carry a real text layer — no OCR, no Tesseract, no image work at
all (OBSERVATIONS-ASD.md §1). `asd_parser.py` does the actual reading; this
script is only the fetch/resume/fan-out shell around it, mirroring 2-extract.py
so the two pipelines stay easy to compare, not because they share any code.

PyMuPDF is not thread-safe (verified the hard way in the source document) —
this MUST stay on ProcessPoolExecutor. Do not "simplify" it to threads.

A 404 here is data, not a failure: it means that booth had no uncollectable
electors, and must be recorded as a read part with zero rows so ASD coverage
does not understate. Every other HTTP status / timeout / connection error is a
real fetch failure and is retried, exactly as stage 2 does.
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
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).parent / 'ocr'))
from asd_parser import read_asd_bytes  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(os.environ.get('ROLL_CACHE', ROOT / 'cache'))
ASD_ROWS = CACHE / 'asd-rows'
ASD_DONE = CACHE / 'asd-done'

CDN_BASE = 'https://voters.eci.gov.in'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')


def source_url(ac: int, part: int) -> str:
    """https://voters.eci.gov.in/eroll/asd/2026/s10/{ac}/uncollectable_elector_report_ac{ac}_part{part}_KAN.pdf
    All-lowercase path and filename apart from KAN — no casing split, unlike
    the draft roll's URL (OBSERVATIONS-ASD.md §1)."""
    name = f'uncollectable_elector_report_ac{ac}_part{part}_KAN.pdf'
    return f'{CDN_BASE}/eroll/asd/2026/s10/{ac}/{name}'


class NotFound(Exception):
    """A genuine 404 — that booth has no ASD report. Not retried, not an
    error; the caller turns this into a zero-row successful read."""


def fetch(url: str, tries: int = 3, timeout: int = 60) -> bytes:
    last_exc: Exception | None = None
    for attempt in range(tries):
        try:
            req = Request(url, headers={'User-Agent': UA})
            with urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            if data[:5] != b'%PDF-':
                raise ValueError('response is not a PDF')
            return data
        except HTTPError as e:
            if e.code == 404:
                raise NotFound from None
            last_exc = e
        except Exception as e:  # noqa: BLE001 — genuinely retry anything else
            last_exc = e
        if attempt < tries - 1:
            time.sleep(1.5 * (attempt + 1))
    raise last_exc or RuntimeError('fetch failed with no captured exception')


def do_part(job: dict) -> dict:
    """Runs in a worker process. Never touches the draft-roll pipeline's own
    cache paths, rows, or done ledger."""
    try:
        data = fetch(source_url(job['ac'], job['part']))
    except NotFound:
        return {**job, 'notFound': True, 'rows': [], 'header': None}
    except Exception as exc:  # noqa: BLE001
        return {**job, 'error': f'{type(exc).__name__}: {exc}', 'rows': []}

    try:
        rows, header = read_asd_bytes(data)
    except Exception as exc:  # noqa: BLE001
        return {**job, 'error': f'parse {type(exc).__name__}: {exc}', 'rows': []}

    out = [
        {'ac': job['ac'], 'part': job['part'],
         'serial': r.serial, 'epic': r.epic, 'name': r.name,
         'relation': r.relation, 'relativeName': r.relativeName,
         'oldPart': r.oldPart, 'oldSerial': r.oldSerial, 'age': r.age, 'sex': r.sex,
         'reasonCode': r.reasonCode, 'ok': r.ok}
        for r in rows
    ]
    return {**job, 'rows': out,
            'headerPartName': header.partName if header else '',
            'headerAcName': header.acName if header else ''}


def load_jobs(args) -> list[dict]:
    manifest = json.loads((CACHE / 'manifest.json').read_text('utf8'))
    jobs = []
    for ac in manifest['constituencies']:
        if args.ac and ac['acNumber'] != args.ac:
            continue
        for part in ac['parts']:
            jobs.append({'ac': ac['acNumber'], 'part': part['partNumber']})
    return jobs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--ac', type=int)
    ap.add_argument('--limit', type=int)
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 4) - 1))
    args = ap.parse_args()

    ASD_ROWS.mkdir(parents=True, exist_ok=True)
    ASD_DONE.mkdir(parents=True, exist_ok=True)

    jobs = load_jobs(args)
    done: set[tuple[int, int]] = set()
    for ledger in ASD_DONE.glob('*.txt'):
        ac = int(ledger.stem)
        done |= {(ac, int(x)) for x in ledger.read_text('utf8').split() if x.strip()}
    jobs = [j for j in jobs if (j['ac'], j['part']) not in done]
    if args.limit:
        jobs = jobs[:args.limit]

    if not jobs:
        print('Nothing to do — every part in scope is already extracted (ASD).')
        return 0
    print(f'{len(jobs)} ASD parts to read, {args.workers} workers')

    handles: dict[int, io.TextIOBase] = {}
    ledgers: dict[int, io.TextIOBase] = {}
    total_rows = unread = not_found = 0
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
                    handles[ac] = (ASD_ROWS / f'{ac}.jsonl').open('a', encoding='utf8')
                    ledgers[ac] = (ASD_DONE / f'{ac}.txt').open('a', encoding='utf8')

                if res.get('notFound'):
                    not_found += 1
                else:
                    for row in res['rows']:
                        handles[ac].write(json.dumps(row, ensure_ascii=False) + '\n')
                    handles[ac].flush()
                    total_rows += len(res['rows'])

                # A 404 is a completed read of a zero-row booth — marked done
                # exactly like a part with rows, so it is never retried.
                ledgers[ac].write(f"{res['part']}\n")
                ledgers[ac].flush()

                if n % 25 == 0 or n == len(jobs):
                    rate = n / max(1e-9, time.time() - started)
                    print(f'  [{n}/{len(jobs)}] {total_rows} rows, {not_found} no-report (404), '
                          f'{unread} unreadable, {rate*60:.0f} parts/min')
    finally:
        for h in (*handles.values(), *ledgers.values()):
            h.close()

    print(f'\n{total_rows} rows, {not_found} parts with no ASD report, '
          f'{unread} parts unreadable, in {(time.time()-started)/60:.1f} min')
    return 0


if __name__ == '__main__':
    sys.exit(main())
