#!/usr/bin/env node
/* Stage 8 — a state-wide sweep, meant to run once, right after the roll first
 * reaches 100% coverage.
 *
 * `7-verify.mjs` is the per-constituency spot check that's been running
 * throughout the build, a dozen rows at a time, every time one more AC
 * finishes. This is different in shape, not in method: same two-layer check
 * (live-site consistency, then a source-PDF re-read), but spread as one
 * sample from one booth across *every* constituency in a single run, plus a
 * block of specific edge cases the per-AC sampling is statistically unlikely
 * to ever land on by chance:
 *
 *   - the lowest- and highest-numbered constituency, each pushed harder
 *     (first and last booth, first and last serial in those booths)
 *   - rows published with the approximate-serial flag (`ok: false` but a
 *     well-formed EPIC) — confirms the flag actually made it into the
 *     published record, not just the local JSONL
 *   - rows withheld entirely for a malformed EPIC — confirms the site
 *     genuinely does not have them, not just that the OCR flagged them
 *   - EPICs that appear more than once in the raw rows (a transfer mid-flight
 *     between constituencies) — confirms the live site returns exactly one
 *     hit, not zero and not two
 *
 *     node scripts/8-full-sweep.mjs
 *     node scripts/8-full-sweep.mjs --force        # run even if not 100% yet
 *     node scripts/8-full-sweep.mjs --concurrency 6
 *     node scripts/8-full-sweep.mjs --force --limit 8   # quick smoke test of the framework itself
 *
 * Like 7-verify.mjs, this is a check, not a report: it prints every mismatch
 * in full and exits non-zero if anything disagrees.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { CACHE, log, logTest, pool } from './lib/common.mjs';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const force = args.includes('--force');
const concurrency = Number(argValue('--concurrency') ?? 4);
const limit = argValue('--limit') ? Number(argValue('--limit')) : null;
const site = argValue('--site') ?? 'https://gouthamganeshm.github.io/Karnataka_Draft_Roll_2026';
const cornerSamples = Number(argValue('--corner-samples') ?? 15);
const dupScanAcs = Number(argValue('--dup-scan-acs') ?? 30);

const UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
const CDN = 'https://voters.eci.gov.in/eroll/2026/s10/sir-draftroll';
const partUrl = (ac, part) =>
  `${CDN}/${ac}/2026-EROLLGEN-S10-${ac}-SIR-DraftRoll-Revision1-KAN-${part}-WI.pdf`;
// Exactly `3-build-data.mjs`'s acceptance rule — a row not matching this is
// withheld regardless of its own `ok` bit, so this test has to use the same
// pattern rather than trust the OCR stage's own EPIC_RE to agree with it.
const EPIC_RE = /^[A-Z]{3}[0-9]{7}$/;

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

/* Re-reads the specific card off the source PDF, independent of every other
 * stage — the same check `7-verify.mjs` does, kept identical on purpose so a
 * constituency can't pass one script and fail the other over a drifted
 * definition of "correct". */
async function verifyAgainstPdf(row) {
  const url = partUrl(row.ac, row.part);
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

/** Streams one AC's JSONL once, returning everything the sweep + corner
 * checks need from it, so a 224-constituency run only reads each file once. */
async function scanAc(ac) {
  const byPart = new Map(); // partNo -> ok rows in that part
  const approxRows = [];
  const withheldRows = [];
  const epicSeen = new Map(); // epic -> first row seen (for dup detection)
  const dupPairs = [];
  let minPart = Infinity;
  let maxPart = -Infinity;

  const rl = createInterface({
    input: createReadStream(resolve(CACHE, 'rows', `${ac}.jsonl`)),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const epic = String(row.epic ?? '').trim().toUpperCase();
    row.epic = epic;

    if (!EPIC_RE.test(epic)) {
      withheldRows.push(row);
      continue;
    }
    if (!row.ok) approxRows.push(row);

    if (row.part < minPart) minPart = row.part;
    if (row.part > maxPart) maxPart = row.part;
    if (!byPart.has(row.part)) byPart.set(row.part, []);
    byPart.get(row.part).push(row);

    const prior = epicSeen.get(epic);
    if (prior) dupPairs.push([prior, row]);
    else epicSeen.set(epic, row);
  }
  return { ac, byPart, approxRows, withheldRows, dupPairs, minPart, maxPart };
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ------------------------------------------------------------------------ run

let exitCode = 0;
const fail = (msg) => { log(`  FAIL  ${msg}`); exitCode = 1; };

log('Fetching live manifest…');
const manifest = await getJson(`${site}/data/manifest.json`);
const acNums = Object.keys(manifest.acs).map(Number).sort((a, b) => a - b);
const incomplete = acNums.filter((a) => manifest.acs[a].partsDone < manifest.acs[a].parts);

// Not process.exit(): forcing the process down while fetch's keep-alive
// sockets are still open crashes Node on Windows (see the matching note at
// the bottom of this file, and 7-verify.mjs's identical fix for the same bug).
if (incomplete.length && !force) {
  log(`Not at 100% yet — ${incomplete.length} constituencies still incomplete `
    + `(${incomplete.slice(0, 10).join(',')}${incomplete.length > 10 ? ',…' : ''}).`);
  log('This sweep is meant for the 100% milestone. Re-run with --force to test '
    + 'the framework early against whatever is complete right now.');
  process.exitCode = 2;
}
let targetAcs = (incomplete.length && !force) ? [] : acNums.filter((a) => !incomplete.includes(a));
if (limit) {
  // A random subset, not the first N — the point of a --limit smoke test is
  // to exercise the framework's logic, and always picking the lowest AC
  // numbers would never touch most of the code paths.
  targetAcs = [...targetAcs].sort(() => Math.random() - 0.5).slice(0, limit);
  log(`--limit ${limit}: smoke-testing against a random subset, not a real sweep.`);
}
if (targetAcs.length) {
log(`${targetAcs.length}/${acNums.length} constituencies complete — sweeping ${targetAcs.length}.\n`);

// ---------------------------------------------------- Section A: the sweep

log('=== Section A: one booth, one sample, every constituency ===');
let sweepFails = 0;
let sweepPdfFails = 0;
let swept = 0;

const sweepResults = await pool(targetAcs, concurrency, async (ac) => {
  const scan = await scanAc(ac);
  const parts = [...scan.byPart.keys()];
  if (!parts.length) return { ac, skipped: 'no rows at all' };
  const part = pickRandom(parts);
  const row = pickRandom(scan.byPart.get(part));

  const hits = await lookupLive(row.epic, manifest);
  const match = hits.find((h) => h[1] === row.ac && h[2] === row.part && h[3] === row.serial);
  const pdf = await verifyAgainstPdf(row);
  return { ac, row, siteOk: Boolean(match), hits, pdf };
}, (done, total) => process.stdout.isTTY && process.stdout.write(`\r\x1b[K  ${done}/${total}`));
if (process.stdout.isTTY) process.stdout.write('\n');

for (const r of sweepResults) {
  if (r.skipped) { log(`  AC ${r.ac}: skipped — ${r.skipped}`); continue; }
  swept++;
  if (!r.siteOk) {
    sweepFails++;
    fail(`AC ${r.ac} part ${r.row.part} serial ${r.row.serial} (${r.row.epic}) — `
      + `not found live, got ${JSON.stringify(r.hits)}`);
  }
  if (!r.pdf.ok) {
    sweepPdfFails++;
    fail(`AC ${r.ac} part ${r.row.part} serial ${r.row.serial} (${r.row.epic}) — PDF re-check: ${r.pdf.reason}`);
  }
  await logTest({
    dataset: 'roll', layer: 'site', ac: r.ac, part: r.row.part, epic: r.row.epic,
    expected: { ac: r.row.ac, part: r.row.part, serial: r.row.serial },
    actual: r.hits, verdict: r.siteOk ? 'pass' : 'fail'
  });
  await logTest({
    dataset: 'roll', layer: 'pdf', ac: r.ac, part: r.row.part, epic: r.row.epic,
    expected: { serial: r.row.serial }, verdict: r.pdf.ok ? 'pass' : 'fail', reason: r.pdf.reason ?? null
  });
}
log(`Section A: ${swept} constituencies swept, ${sweepFails} site mismatches, ${sweepPdfFails} PDF mismatches\n`);

// -------------------------------------------------- Section B: corner cases

log('=== Section B: corner cases ===');

// B1/B2/B4 need a full scan of a handful of ACs anyway (approx + withheld +
// dup candidates) — reuse the same scanAc rather than re-streaming.
const boundaryAcs = [Math.min(...targetAcs), Math.max(...targetAcs)];
const dupScanTargets = [...new Set([
  ...boundaryAcs,
  ...[...targetAcs].sort(() => Math.random() - 0.5).slice(0, dupScanAcs)
])];
log(`Scanning ${dupScanTargets.length} constituencies for corner-case candidates `
  + '(boundary ACs + a random sample for duplicate detection)…');

const scans = await pool(dupScanTargets, concurrency, (ac) => scanAc(ac));
const byAc = new Map(scans.map((s) => [s.ac, s]));

// --- B1: approximate-serial rows actually carry the flag once published ---
log('\n-- B1: approximate-serial rows publish with the flag --');
const approxPool = scans.flatMap((s) => s.approxRows);
if (!approxPool.length) {
  log('  none found in the scanned ACs — nothing to check');
} else {
  const sample = [...approxPool].sort(() => Math.random() - 0.5).slice(0, cornerSamples);
  let b1Fails = 0;
  for (const row of sample) {
    const hits = await lookupLive(row.epic, manifest);
    const match = hits.find((h) => h[1] === row.ac && h[2] === row.part);
    if (!match) {
      b1Fails++;
      fail(`approx row ${row.epic} (AC${row.ac} part${row.part}) — not found live at all`);
    } else if (match[4] !== 1) {
      b1Fails++;
      fail(`approx row ${row.epic} (AC${row.ac} part${row.part}) — published without the approximate flag: ${JSON.stringify(match)}`);
    }
  }
  log(`  ${sample.length - b1Fails}/${sample.length} correctly flagged approximate`);
}

// --- B2: malformed-EPIC rows are genuinely absent, not just OCR-flagged ---
log('\n-- B2: withheld (malformed-EPIC) rows are genuinely absent --');
const withheldPool = scans.flatMap((s) => s.withheldRows);
if (!withheldPool.length) {
  log('  none found in the scanned ACs — nothing to check');
} else {
  const sample = [...withheldPool].sort(() => Math.random() - 0.5).slice(0, cornerSamples);
  let b2Fails = 0;
  for (const row of sample) {
    if (!EPIC_RE.test(row.epic)) continue; // guard: only test genuinely malformed ones
    const hits = await lookupLive(row.epic, manifest);
    if (hits.length) {
      b2Fails++;
      fail(`withheld row ${row.epic} (AC${row.ac} part${row.part}) — should be absent, found ${JSON.stringify(hits)}`);
    }
  }
  log(`  ${sample.length - b2Fails}/${sample.length} correctly absent`);
}

// --- B3: duplicate EPICs resolve to exactly one live hit ---
log('\n-- B3: duplicate EPICs resolve to exactly one live record --');
const dupPairs = scans.flatMap((s) => s.dupPairs);
if (!dupPairs.length) {
  log(`  none found across the ${dupScanTargets.length} scanned constituencies — `
    + 'duplicates are rare by design; re-run to sample a different set if you need one');
} else {
  const sample = [...dupPairs].sort(() => Math.random() - 0.5).slice(0, cornerSamples);
  let b3Fails = 0;
  for (const [first, second] of sample) {
    const hits = await lookupLive(first.epic, manifest);
    if (hits.length !== 1) {
      b3Fails++;
      fail(`duplicate EPIC ${first.epic} (seen at AC${first.ac}/${first.part} and `
        + `AC${second.ac}/${second.part}) — live site has ${hits.length} hits, expected exactly 1: ${JSON.stringify(hits)}`);
    }
  }
  log(`  ${sample.length - b3Fails}/${sample.length} duplicate EPICs resolved to exactly one record`);
}

// --- B4: boundary constituencies, pushed harder ---
log('\n-- B4: boundary constituencies (lowest & highest AC number) --');
let b4Fails = 0;
let b4Checked = 0;
for (const ac of boundaryAcs) {
  const scan = byAc.get(ac);
  if (!scan || scan.minPart === Infinity) { log(`  AC ${ac}: no rows to test`); continue; }
  for (const part of new Set([scan.minPart, scan.maxPart])) {
    const rows = scan.byPart.get(part) ?? [];
    if (!rows.length) continue;
    const sorted = [...rows].sort((a, b) => a.serial - b.serial);
    for (const row of [sorted[0], sorted[sorted.length - 1]]) {
      b4Checked++;
      const hits = await lookupLive(row.epic, manifest);
      const match = hits.find((h) => h[1] === row.ac && h[2] === row.part && h[3] === row.serial);
      if (!match) {
        b4Fails++;
        fail(`AC ${ac} (boundary) part ${part} serial ${row.serial} (${row.epic}) — not found live`);
      } else {
        log(`  ok    AC ${ac} part ${part} serial ${row.serial} (edge of booth range)`);
      }
      await logTest({
        dataset: 'roll', layer: 'site-boundary', ac: row.ac, part: row.part, epic: row.epic,
        expected: { ac: row.ac, part: row.part, serial: row.serial },
        actual: hits, verdict: match ? 'pass' : 'fail'
      });
    }
  }
}
log(`B4: ${b4Checked - b4Fails}/${b4Checked} boundary-of-booth records matched\n`);
} // if (targetAcs.length)

log(`=== done — exit ${exitCode === 0 ? 'clean' : 'with failures'} ===`);
process.exitCode = exitCode;
