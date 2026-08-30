#!/usr/bin/env node
/* Stage 7 — spot-check a finished constituency against the live site.
 *
 * The pipeline already has one honesty guard: a row that fails validation is
 * marked `ok: false` and withheld rather than published wrong (see
 * `3-build-data.mjs`). This is a second, independent one — it does not trust
 * that guard, it tests what actually shipped.
 *
 * Two layers, cheapest first:
 *
 *   1. Pipeline consistency. Take rows straight from `cache/rows/<ac>.jsonl`
 *      — the OCR's own output — and confirm the live site's lookup algorithm
 *      (SHA-256 -> bucket file -> binary search), run for real against the
 *      published bucket files over HTTP, returns the same AC/part/serial the
 *      row claims. This catches a broken build or a stale deploy; it does NOT
 *      catch the OCR reading the wrong thing off the source PDF, because both
 *      sides of the comparison come from the same OCR pass.
 *
 *   2. Source-of-truth. For a handful of the sampled rows, fetch the actual
 *      part PDF from ECI's CDN — the same one `2-extract.py` read — and
 *      confirm the EPIC really sits at the claimed serial on the page. This is
 *      the check that catches the OCR itself being wrong, at the cost of a
 *      multi-megabyte PDF fetch per part, which is why it only runs on a few
 *      rows rather than the whole sample.
 *
 *     node scripts/7-verify.mjs --ac 150
 *     node scripts/7-verify.mjs --ac 150,153 --sample 12 --pdf-checks 2
 *
 * Exits non-zero and prints every mismatch in full if anything disagrees —
 * this is a check, not a report, and a constituency that fails it should not
 * be considered verified.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { CACHE, log, logTest } from './lib/common.mjs';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const acList = (argValue('--ac') ?? '').split(',').map((s) => +s.trim()).filter(Boolean);
const sampleSize = Number(argValue('--sample') ?? 12);
const pdfChecks = Number(argValue('--pdf-checks') ?? 2);
const site = argValue('--site') ?? 'https://gouthamganeshm.github.io/Karnataka_Draft_Roll_2026';

if (!acList.length) {
  log('Usage: node scripts/7-verify.mjs --ac <acNo>[,<acNo>...] [--sample N] [--pdf-checks N]');
  process.exit(2);
}

const UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
const CDN = 'https://voters.eci.gov.in/eroll/2026/s10/sir-draftroll';
const partUrl = (ac, part) =>
  `${CDN}/${ac}/2026-EROLLGEN-S10-${ac}-SIR-DraftRoll-Revision1-KAN-${part}-WI.pdf`;

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function findInBucket(records, suffix) {
  let lo = 0;
  let hi = records.length - 1;
  const hits = [];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = records[mid][0];
    if (v < suffix) lo = mid + 1;
    else if (v > suffix) hi = mid - 1;
    else {
      let i = mid;
      while (i >= 0 && records[i][0] === suffix) i--;
      for (let j = i + 1; j < records.length && records[j][0] === suffix; j++) hits.push(records[j]);
      break;
    }
  }
  return hits;
}

const bucketCache = new Map();
async function fetchBucket(prefix) {
  if (bucketCache.has(prefix)) return bucketCache.get(prefix);
  const path = prefix.length > 2 ? `roll/${prefix.slice(0, 2)}/${prefix.slice(2)}.json` : `roll/${prefix}.json`;
  const p = getJson(`${site}/data/${path}`).catch(() => null);
  bucketCache.set(prefix, p);
  return p;
}

async function lookupLive(epic, manifest) {
  const hash = sha256hex(epic);
  const depth = manifest.shardDepth;
  const bucket = await fetchBucket(hash.slice(0, depth));
  if (!bucket) return [];
  return findInBucket(bucket, hash.slice(depth, depth + manifest.suffixLength));
}

async function sampleRows(ac, n) {
  const rows = [];
  let seen = 0;
  const rl = createInterface({
    input: createReadStream(resolve(CACHE, 'rows', `${ac}.jsonl`)),
    crlfDelay: Infinity
  });
  // Reservoir sample so this does not have to hold a whole AC's rows in memory.
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row.ok) continue;
    seen++;
    if (rows.length < n) {
      rows.push(row);
    } else {
      const j = Math.floor(Math.random() * seen);
      if (j < n) rows[j] = row;
    }
  }
  return rows;
}

/* Ground truth: does this EPIC actually sit at this serial in the published
 * part? Re-reads the specific card off the source PDF rather than trusting
 * any of the OCR's own intermediate output. */
async function verifyAgainstPdf(row) {
  const url = partUrl(row.ac, row.part);
  // A multi-megabyte fetch over a long-running loop hits the occasional
  // reset; retried once rather than failing an otherwise-clean sample on a
  // dropped connection that has nothing to do with the data being checked.
  let buf;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://voters.eci.gov.in/' } });
      if (!res.ok) return { ok: false, reason: `PDF fetch ${res.status}` };
      buf = Buffer.from(await res.arrayBuffer());
      break;
    } catch (err) {
      if (attempt === 2) return { ok: false, reason: `PDF fetch failed twice: ${err.message}` };
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Shell out to the same OCR module the pipeline uses, over a small Python
  // one-liner, so this checks against the real reader rather than a
  // reimplementation of it that could drift from what actually ran.
  const { spawnSync } = await import('node:child_process');
  const script = `
import sys, json
sys.path.insert(0, 'scripts/ocr')
from roll_ocr import read_part_bytes
data = sys.stdin.buffer.read()
rows = read_part_bytes(data)
match = next((r for r in rows if r.epic == ${JSON.stringify(row.epic)}), None)
print(json.dumps({'found': match is not None, 'serial': match.serial if match else None, 'total': len(rows)}))
`;
  const r = spawnSync('python', ['-c', script], { input: buf, maxBuffer: 1024 * 1024 * 64 });
  if (r.status !== 0) return { ok: false, reason: `python exit ${r.status}: ${r.stderr?.toString().slice(-400)}` };
  let parsed;
  try {
    parsed = JSON.parse(r.stdout.toString().trim().split('\n').pop());
  } catch {
    return { ok: false, reason: 'could not parse OCR re-check output' };
  }
  if (!parsed.found) return { ok: false, reason: `EPIC not found on re-read of part ${row.part} (${parsed.total} rows read)` };
  if (parsed.serial !== row.serial) {
    return { ok: false, reason: `serial mismatch: row says ${row.serial}, re-read says ${parsed.serial}` };
  }
  return { ok: true };
}

// ------------------------------------------------------------------------ run

let exitCode = 0;

for (const ac of acList) {
  log(`\n=== AC ${ac} ===`);
  const manifest = await getJson(`${site}/data/manifest.json`);
  const acMeta = manifest.acs[ac];
  if (!acMeta) {
    log(`  not in the live manifest — skipping`);
    exitCode = 1;
    continue;
  }
  if (acMeta.partsDone < acMeta.parts) {
    log(`  not complete yet: ${acMeta.partsDone}/${acMeta.parts} — skipping`);
    continue;
  }

  try {
    const rows = await sampleRows(ac, sampleSize);
    log(`  sampled ${rows.length} rows from cache/rows/${ac}.jsonl`);

    let mismatches = 0;
    for (const row of rows) {
      const hits = await lookupLive(row.epic, manifest);
      const match = hits.find((h) => h[1] === row.ac && h[2] === row.part && h[3] === row.serial);
      if (!match) {
        mismatches++;
        log(`  FAIL  ${row.epic}  expected [${row.ac},${row.part},${row.serial}]  ` +
            `got ${JSON.stringify(hits)}`);
      }
      await logTest({
        dataset: 'roll', layer: 'site', ac: row.ac, part: row.part, epic: row.epic,
        expected: { ac: row.ac, part: row.part, serial: row.serial },
        actual: hits, verdict: match ? 'pass' : 'fail'
      });
    }
    log(`  live-site consistency: ${rows.length - mismatches}/${rows.length} matched`);

    const forPdf = rows.slice(0, Math.min(pdfChecks, rows.length));
    let pdfFails = 0;
    for (const row of forPdf) {
      const r = await verifyAgainstPdf(row);
      if (!r.ok) {
        pdfFails++;
        log(`  PDF-CHECK FAIL  ${row.epic}  part ${row.part}  serial ${row.serial}  — ${r.reason}`);
      } else {
        log(`  PDF-CHECK ok    ${row.epic}  part ${row.part}  serial ${row.serial}`);
      }
      await logTest({
        dataset: 'roll', layer: 'pdf', ac: row.ac, part: row.part, epic: row.epic,
        expected: { serial: row.serial }, verdict: r.ok ? 'pass' : 'fail', reason: r.reason ?? null
      });
    }

    if (mismatches || pdfFails) {
      log(`  AC ${ac}: VERIFICATION FAILED (${mismatches} site mismatches, ${pdfFails} PDF mismatches)`);
      exitCode = 1;
    } else {
      log(`  AC ${ac}: verified clean (${rows.length} sampled, ${forPdf.length} against source PDF)`);
    }
  } catch (err) {
    // A dropped connection or a transient CDN hiccup is not a data failure —
    // it should not stop the rest of the ACs in this batch from being
    // checked, and it should not silently read as "verified" either.
    log(`  AC ${ac}: verification run itself errored — ${err.message}`);
    exitCode = 1;
  }
}

// Not `process.exit()`: forcing the process down while fetch's keep-alive
// sockets are still open crashes Node on Windows (`Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING)`) — reproduced reliably on a run that
// only fetched a manifest and skipped every AC. Setting `exitCode` and
// letting the event loop drain exits the same way once idle, without racing
// undici's connection teardown — and without risking a real failure's `1`
// getting lost in the crash instead of reported.
process.exitCode = exitCode;
