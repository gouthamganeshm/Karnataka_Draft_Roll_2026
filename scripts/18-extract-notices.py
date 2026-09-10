"""Stage 18 — CEO "notices issued" PDFs (Google Drive) to rows.

Third dataset, sibling of `2-extract.py` (roll) and `9-extract-asd.py`
(ASD) — same isolation rule as both of those state explicitly: this must
never share cache paths, rows, or done ledgers with either. Writes only to
`cache/notices-rows/`, `cache/notices-done.txt`, and
`cache/notices-unresolved.jsonl`.

Unlike the roll/ASD CDN, the job list here is not "every (ac, part) in the
manifest" — it is "every PDF `17-discover-notices.mjs` found," because which
file corresponds to which (ac, part) is exactly what still needs figuring
out per file (see `scripts/ocr/notices_parser.py`'s module docstring for why:
at least two PDF templates and three filename conventions are already known
to coexist across the 34 independently-uploaded Drive trees). Resumability
is therefore keyed by Drive file ID, not by (ac, part).

A file whose AC/part/template cannot be identified is recorded in
`cache/notices-unresolved.jsonl` — never silently dropped, matching this
project's standing rule that a source the pipeline cannot read must show up
as reduced coverage, not as a booth that looks clean because nobody looked.

A job whose `kind` is `'zip'` (see `17-discover-notices.mjs`) is a whole
archive of per-part PDFs uploaded as one file — `read_zip_members` unpacks
and parses each member the same way, fanning one job out into many rows
(or unresolved entries) instead of one.

    python scripts/18-extract-notices.py                 # everything found
    python scripts/18-extract-notices.py --limit 50       # a taste
    python scripts/18-extract-notices.py --pull-size 5000 --cooldown-s 600
                                                           # pace against Drive's quota
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import zipfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).parent / 'ocr'))
from notices_parser import read_notices_pdf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(os.environ.get('ROLL_CACHE', ROOT / 'cache'))
NOTICES_ROWS = CACHE / 'notices-rows'
DONE_LEDGER = CACHE / 'notices-done.txt'
UNRESOLVED_LOG = CACHE / 'notices-unresolved.jsonl'

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')


class DriveRateLimited(Exception):
    """Google's anonymous-download abuse guard, not a per-file problem.

    Found the hard way: after ~10,000 files pulled through
    `uc?export=download` in one run, every further request — even for files
    already proven to exist — silently 200s with an HTML sign-in page
    (`/v3/signin/identifier?...ServiceLogin...`) instead of the PDF. Retrying
    the same file does nothing (this is a blanket block, not a fluke), and
    without a real Google login there is no way to push through it, so this
    is deliberately NOT retried like every other fetch failure — it aborts
    the whole run immediately with a clear message instead of grinding
    through the rest of the queue at ~19s/file of pure retry-and-fail. Rerun
    later; the block is presumed to lift after a cooldown (not measured how
    long), and every already-extracted file stays done via the ledger."""


def fetch(file_id: str, kind: str = 'pdf', tries: int = 4, timeout: int = 60) -> bytes:
    url = f'https://drive.google.com/uc?export=download&id={file_id}'
    magic = b'PK' if kind == 'zip' else b'%PDF-'
    last_exc: Exception | None = None
    for attempt in range(tries):
        try:
            req = Request(url, headers={'User-Agent': UA})
            with urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            if data[:len(magic)] == magic:
                return data
            if b'ServiceLogin' in data or b'accounts.google.com' in data:
                raise DriveRateLimited(
                    'Drive is serving a sign-in wall instead of files — anonymous download quota hit')
            raise ValueError(f'response is not a {kind} ({len(data)} bytes)')
        except DriveRateLimited:
            raise  # not retried — see the class docstring
        except Exception as e:  # noqa: BLE001 — retry anything else, Drive's other failure modes are not well documented
            last_exc = e
        if attempt < tries - 1:
            time.sleep(1.5 * (attempt + 1))
    raise last_exc or RuntimeError('fetch failed with no captured exception')


def read_zip_members(data: bytes, path: list[str], file_id: str) -> list[dict]:
    """A zip of per-part PDFs, uploaded as one archive instead of individual
    files — found 2026-09-09 in Vijayanagara (4 of its 5 ACs). Each member is
    parsed exactly like a standalone PDF job via the same `read_notices_pdf`;
    no `notices_parser.py` changes needed, since the PDFs inside are the same
    Template A content as everywhere else, just bundled. Returns a list, not
    a single (ac, part) — nothing guarantees an archive can't span more than
    one AC, even though every real case seen so far has not."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        return [{'name': '(archive)', 'error': f'BadZipFile: {exc}'}]

    members = []
    for name in zf.namelist():
        if not name.lower().endswith('.pdf'):
            continue
        base_name = name.rsplit('/', 1)[-1]
        try:
            pdf_bytes = zf.read(name)
            ac, part, method, template, rows = read_notices_pdf(pdf_bytes, base_name, path)
        except Exception as exc:  # noqa: BLE001
            members.append({'name': base_name, 'error': f'{type(exc).__name__}: {exc}'})
            continue
        if ac is None or part is None or template is None:
            members.append({'name': base_name, 'unresolved': True, 'ac': ac, 'part': part,
                             'method': method, 'template': template})
        else:
            members.append({'name': base_name, 'ac': ac, 'part': part, 'method': method, 'template': template,
                             'rows': [{'ac': ac, 'part': part, 'serial': r.serial, 'epic': r.epic,
                                       'name': r.name, 'reason': r.reason, 'age': r.age, 'gender': r.gender,
                                       'ok': True, 'method': method, 'template': template,
                                       # Points at the archive, not the individual PDF — Drive has no
                                       # deep-link into a zip member, so the archive is the closest
                                       # real source link the UI can offer for this row.
                                       'fileId': file_id} for r in rows]})
    return members


def do_file(job: dict) -> dict:
    """Runs in a worker process."""
    kind = job.get('kind', 'pdf')
    try:
        data = fetch(job['fileId'], kind=kind)
    except DriveRateLimited as exc:
        # A dict marker, not a re-raised exception: simpler than relying on
        # cross-process exception pickling, and the caller only needs to
        # know "stop everything now", not this class's full identity.
        return {**job, 'rateLimited': True, 'error': str(exc)}
    except Exception as exc:  # noqa: BLE001
        return {**job, 'error': f'{type(exc).__name__}: {exc}'}

    if kind == 'zip':
        return {**job, 'archiveMembers': read_zip_members(data, job['path'], job['fileId'])}

    try:
        ac, part, method, template, rows = read_notices_pdf(data, job['name'], job['path'])
    except Exception as exc:  # noqa: BLE001
        return {**job, 'error': f'parse {type(exc).__name__}: {exc}'}

    if ac is None or part is None or template is None:
        return {**job, 'unresolved': True, 'ac': ac, 'part': part, 'method': method, 'template': template}

    out_rows = [
        {'ac': ac, 'part': part, 'serial': r.serial, 'epic': r.epic, 'name': r.name,
         'reason': r.reason, 'age': r.age, 'gender': r.gender, 'ok': True,
         'method': method, 'template': template, 'fileId': job['fileId']}
        for r in rows
    ]
    return {**job, 'ac': ac, 'part': part, 'method': method, 'template': template, 'rows': out_rows}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int)
    ap.add_argument('--district', help='comma-separated, matches 17-discover-notices.mjs district names')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 4) - 1))
    ap.add_argument('--pull-size', type=int, default=5000,
                     help='pause for --cooldown-s after this many files, to pace requests against '
                          "Drive's anonymous-download quota (see DriveRateLimited's docstring) "
                          'rather than hammering it continuously')
    ap.add_argument('--cooldown-s', type=int, default=600)
    args = ap.parse_args()

    NOTICES_ROWS.mkdir(parents=True, exist_ok=True)

    manifest = json.loads((CACHE / 'notices-manifest.json').read_text('utf8'))
    jobs = manifest['files']
    if args.district:
        wanted = {d.strip() for d in args.district.split(',')}
        jobs = [j for j in jobs if j['district'] in wanted]

    done: set[str] = set()
    if DONE_LEDGER.exists():
        done = {x.strip() for x in DONE_LEDGER.read_text('utf8').split() if x.strip()}
    jobs = [j for j in jobs if j['fileId'] not in done]
    if args.limit:
        jobs = jobs[:args.limit]

    if not jobs:
        print('Nothing to do — every discovered notices PDF is already extracted.')
        return 0
    print(f'{len(jobs)} notices PDFs to read, {args.workers} workers')

    handles: dict[int, io.TextIOBase] = {}
    unresolved_fh = UNRESOLVED_LOG.open('a', encoding='utf8')
    done_fh = DONE_LEDGER.open('a', encoding='utf8')
    total_rows = errors = unresolved = 0
    by_template: dict[str, int] = {}
    started = time.time()
    n = 0

    # Batched, with a fresh pool per batch, on purpose: a run against ~42,700
    # individually-uploaded Drive files hit a full, silent stall once already
    # (all workers wedged at the same time, no exception raised — root cause
    # not confirmed, but consistent with a PyMuPDF hang on some adversarial
    # PDF; see 9-extract-asd.py's own note that PyMuPDF is not thread-safe
    # and has been unstable "the hard way" before). One giant pool submitted
    # up front has no way to recover from that short of killing the whole
    # process by hand. Recreating the pool every BATCH_SIZE files bounds the
    # blast radius of a repeat: at worst one batch's workers wedge and that
    # batch's files stay unmarked (picked up again next run), instead of the
    # entire remaining run silently going nowhere for hours.
    # A per-batch wall-clock ceiling is the actual backstop, not just the
    # smaller batch size: if this batch's workers wedge, `pool.shutdown()`
    # on the normal `with`-block exit would itself block forever waiting for
    # them, right back to the original all-night stall. `wait=False` +
    # `cancel_futures=True` abandons a wedged batch instead of joining it —
    # its files simply stay off the done ledger and get retried next run.
    BATCH_SIZE = 300
    BATCH_TIMEOUT_S = 600
    rate_limited = False
    since_cooldown = 0  # files completed since the last pull-size pause
    try:
        for batch_start in range(0, len(jobs), BATCH_SIZE):
            if rate_limited:
                break
            # Paced pulling: a real cooldown gap every --pull-size files,
            # not just smaller batches — a fresh pool per 300 files (below)
            # protects against a wedged worker, but does nothing to space
            # out *request volume* over time, which is what Drive's quota
            # actually tracks (see DriveRateLimited's docstring — confirmed
            # the block persists across brand-new connections/processes, so
            # only elapsed time with reduced volume is worth trying here).
            if since_cooldown >= args.pull_size:
                print(f'  paced {args.pull_size} files this pull — cooling down '
                      f'{args.cooldown_s}s before continuing')
                time.sleep(args.cooldown_s)
                since_cooldown = 0
            batch = jobs[batch_start:batch_start + BATCH_SIZE]
            pool = ProcessPoolExecutor(max_workers=args.workers)
            futures = {pool.submit(do_file, j): j for j in batch}
            try:
                completed_iter = as_completed(futures, timeout=BATCH_TIMEOUT_S)
                for fut in completed_iter:
                    n += 1
                    since_cooldown += 1
                    res = fut.result()

                    if res.get('rateLimited'):
                        print(f"\n  Google Drive's anonymous-download quota has been hit "
                              f"({res['error']}). Stopping here rather than burning through "
                              f"the remaining {len(jobs) - n + 1} files against a wall that "
                              f"retrying cannot clear — rerun this script later once the block "
                              f"has had time to lift; every file done so far stays done.")
                        rate_limited = True
                        pool.shutdown(wait=False, cancel_futures=True)
                        break

                    if res.get('error'):
                        errors += 1
                        print(f"  [{n}/{len(jobs)}] {res['name'][:60]}: {res['error']}")
                        continue

                    if res.get('archiveMembers') is not None:
                        # One zip job fans out into many part-PDFs, each resolved
                        # (and written, or logged unresolved) independently — see
                        # read_zip_members's own docstring for why this can't
                        # reuse the single-AC path below.
                        for m in res['archiveMembers']:
                            if m.get('error'):
                                errors += 1
                                print(f"  [{n}/{len(jobs)}] {res['name'][:40]}::{m['name'][:40]}: {m['error']}")
                                continue
                            if m.get('unresolved'):
                                unresolved += 1
                                unresolved_fh.write(json.dumps({
                                    'fileId': res['fileId'], 'name': f"{res['name']}::{m['name']}",
                                    'district': res['district'], 'path': res['path'],
                                    'ac': m.get('ac'), 'part': m.get('part'),
                                    'method': m.get('method'), 'template': m.get('template')
                                }, ensure_ascii=False) + '\n')
                                unresolved_fh.flush()
                                continue
                            ac = m['ac']
                            if ac not in handles:
                                handles[ac] = (NOTICES_ROWS / f'{ac}.jsonl').open('a', encoding='utf8')
                            for row in m['rows']:
                                handles[ac].write(json.dumps(row, ensure_ascii=False) + '\n')
                            handles[ac].flush()
                            total_rows += len(m['rows'])
                            by_template[m['template']] = by_template.get(m['template'], 0) + 1
                    elif res.get('unresolved'):
                        unresolved += 1
                        unresolved_fh.write(json.dumps({
                            'fileId': res['fileId'], 'name': res['name'], 'district': res['district'],
                            'path': res['path'], 'ac': res.get('ac'), 'part': res.get('part'),
                            'method': res.get('method'), 'template': res.get('template')
                        }, ensure_ascii=False) + '\n')
                        unresolved_fh.flush()
                    else:
                        ac = res['ac']
                        if ac not in handles:
                            handles[ac] = (NOTICES_ROWS / f'{ac}.jsonl').open('a', encoding='utf8')
                        for row in res['rows']:
                            handles[ac].write(json.dumps(row, ensure_ascii=False) + '\n')
                        handles[ac].flush()
                        total_rows += len(res['rows'])
                        by_template[res['template']] = by_template.get(res['template'], 0) + 1

                    done_fh.write(res['fileId'] + '\n')
                    done_fh.flush()

                    if n % 100 == 0 or n == len(jobs):
                        rate = n / ((time.time() - started) / 60) if time.time() > started else 0
                        print(f'  [{n}/{len(jobs)}] {total_rows} rows, {unresolved} unresolved, '
                              f'{errors} errors, {rate:.1f} files/min')
                pool.shutdown(wait=True)
            except TimeoutError:
                stuck = sum(1 for f in futures if not f.done())
                print(f'  batch at offset {batch_start} timed out with {stuck} file(s) still stuck — '
                      f'abandoning this batch, they will retry next run')
                pool.shutdown(wait=False, cancel_futures=True)
    finally:
        for fh in handles.values():
            fh.close()
        unresolved_fh.close()
        done_fh.close()

    status = 'Stopped early (rate-limited)' if rate_limited else 'Done'
    print(f'\n{status}. {n}/{len(jobs)} attempted, {total_rows} rows written, {by_template}, '
          f'{unresolved} file(s) unresolved (see cache/notices-unresolved.jsonl), '
          f'{errors} fetch/parse error(s).')
    return 1 if rate_limited else 0


if __name__ == '__main__':
    sys.exit(main())
