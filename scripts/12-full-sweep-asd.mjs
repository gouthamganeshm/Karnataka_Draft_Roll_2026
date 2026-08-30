#!/usr/bin/env node
/* Stage 12 — a state-wide sweep of the ASD data, the sibling of
 * `8-full-sweep.mjs`. Same shape: one booth, one sample, every constituency,
 * plus a block of corner cases specific to what could actually go wrong in
 * this dataset rather than the roll's.
 *
 *     node scripts/12-full-sweep-asd.mjs
 *     node scripts/12-full-sweep-asd.mjs --force --limit 8   # smoke test
 *
 * Corner cases, and why each one earns its place here:
 *
 *   - reason-code mix must land in the four known categories (SHIFTED /
 *     ABSENT / DEAD / DUPLICATE). Any real volume of OTHER is exactly the
 *     class of bug this session already found once (a Unicode-normalization
 *     mismatch silently misclassified ~5.5% of DUPLICATE rows) — this is a
 *     standing regression guard for that, not a one-off check.
 *   - names/relative names are non-empty for a sample of published records —
 *     confirms the "include names" schema decision actually shipped, not a
 *     column that silently stayed blank.
 *   - duplicate EPICs *within ASD* resolve to exactly one live record.
 *   - a **sampled** check for EPICs appearing in *both* the draft roll and
 *     ASD — light-weight, not the full statewide audit (that is its own
 *     separate, exhaustive pipeline task). This just catches a gross
 *     integration bug early, e.g. the two datasets' hashing/bucket depth
 *     disagreeing.
 *   - boundary constituencies (lowest/highest AC number), pushed harder.
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

const UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
const ASD_CDN = 'https://voters.eci.gov.in/eroll/asd/2026/s10';
const asdPartUrl = (ac, part) => `${ASD_CDN}/${ac}/uncollectable_elector_report_ac${ac}_part${part}_KAN.pdf`;
const ROLL_EPIC_RE = /^[A-Z]{3}[0-9]{7}$/; // the draft roll's own acceptance rule, for the cross-list sample

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
async function fetchBucket(base, prefix) {
  const key = `${base}:${prefix}`;
  if (bucketCache.has(key)) return bucketCache.get(key);
  const path = prefix.length > 2 ? `roll/${prefix.slice(0, 2)}/${prefix.slice(2)}.json` : `roll/${prefix}.json`;
  const p = getJson(`${site}/${base}/${path}`).catch(() => null);
  bucketCache.set(key, p);
  return p;
}

async function lookupLiveAsd(epic, manifest) {
  const hash = sha256hex(epic);
  const depth = manifest.shardDepth;
  const bucket = await fetchBucket('data-asd', hash.slice(0, depth));
  if (!bucket) return [];
  return findInBucket(bucket, hash.slice(depth, depth + manifest.suffixLength));
}

async function lookupLiveRoll(epic, rollManifest) {
  const hash = sha256hex(epic);
  const depth = rollManifest.shardDepth;
  const bucket = await fetchBucket('data', hash.slice(0, depth));
  if (!bucket) return [];
  return findInBucket(bucket, hash.slice(depth, depth + rollManifest.suffixLength));
}

async function verifyAgainstPdf(row) {
  const url = asdPartUrl(row.ac, row.part);
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
from asd_parser import read_asd_bytes
data = sys.stdin.buffer.read()
rows, header = read_asd_bytes(data)
match = next((r for r in rows if r.epic == ${JSON.stringify(row.epic)}), None)
print(json.dumps({'found': match is not None, 'serial': match.serial if match else None, 'total': len(rows)}))
`;
  const r = spawnSync('python', ['-c', script], { input: buf, maxBuffer: 1024 * 1024 * 64 });
  if (r.status !== 0) return { ok: false, reason: `python exit ${r.status}: ${r.stderr?.toString().slice(-400)}` };
  let parsed;
  try {
    parsed = JSON.parse(r.stdout.toString().trim().split('\n').pop());
  } catch {
    return { ok: false, reason: 'could not parse ASD re-check output' };
  }
  if (!parsed.found) return { ok: false, reason: `EPIC not found on re-read of part ${row.part} (${parsed.total} rows read)` };
  if (parsed.serial !== row.serial) return { ok: false, reason: `serial mismatch: row says ${row.serial}, re-read says ${parsed.serial}` };
  return { ok: true };
}

async function scanAc(ac) {
  const byPart = new Map();
  const epicSeen = new Map();
  const dupPairs = [];
  const reasonCodes = new Map();
  let minPart = Infinity;
  let maxPart = -Infinity;

  const rl = createInterface({
    input: createReadStream(resolve(CACHE, 'asd-rows', `${ac}.jsonl`)),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row.ok) continue;
    row.epic = String(row.epic).trim().toUpperCase();

    reasonCodes.set(row.reasonCode, (reasonCodes.get(row.reasonCode) ?? 0) + 1);

    if (row.part < minPart) minPart = row.part;
    if (row.part > maxPart) maxPart = row.part;
    if (!byPart.has(row.part)) byPart.set(row.part, []);
    byPart.get(row.part).push(row);

    const prior = epicSeen.get(row.epic);
    if (prior) dupPairs.push([prior, row]);
    else epicSeen.set(row.epic, row);
  }
  return { ac, byPart, dupPairs, reasonCodes, minPart, maxPart };
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ------------------------------------------------------------------------ run

let exitCode = 0;
const fail = (msg) => { log(`  FAIL  ${msg}`); exitCode = 1; };

log('Fetching live ASD manifest…');
const manifest = await getJson(`${site}/data-asd/manifest.json`);
const acNums = Object.keys(manifest.acs).map(Number).sort((a, b) => a - b);
const incomplete = acNums.filter((a) => manifest.acs[a].partsDone < manifest.acs[a].parts);

if (incomplete.length && !force) {
  log(`ASD not at 100% live yet — ${incomplete.length} constituencies still incomplete `
    + `(${incomplete.slice(0, 10).join(',')}${incomplete.length > 10 ? ',…' : ''}).`);
  log('Re-run with --force to test the framework early against whatever is complete right now.');
  process.exitCode = 2;
}
let targetAcs = (incomplete.length && !force) ? [] : acNums.filter((a) => !incomplete.includes(a));
if (limit) {
  targetAcs = [...targetAcs].sort(() => Math.random() - 0.5).slice(0, limit);
  log(`--limit ${limit}: smoke-testing against a random subset, not a real sweep.`);
}

if (targetAcs.length) {
log(`${targetAcs.length}/${acNums.length} constituencies complete — sweeping ${targetAcs.length}.\n`);

// ---------------------------------------------------- Section A: the sweep

log('=== Section A: one booth, one sample, every constituency (ASD) ===');
let sweepFails = 0;
let sweepPdfFails = 0;
let swept = 0;

const sweepResults = await pool(targetAcs, concurrency, async (ac) => {
  const scan = await scanAc(ac);
  const parts = [...scan.byPart.keys()];
  if (!parts.length) return { ac, skipped: 'no rows at all' };
  const part = pickRandom(parts);
  const row = pickRandom(scan.byPart.get(part));

  const hits = await lookupLiveAsd(row.epic, manifest);
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
    dataset: 'asd', layer: 'site', ac: r.ac, part: r.row.part, epic: r.row.epic,
    expected: { ac: r.row.ac, part: r.row.part, serial: r.row.serial },
    actual: r.hits, verdict: r.siteOk ? 'pass' : 'fail'
  });
  await logTest({
    dataset: 'asd', layer: 'pdf', ac: r.ac, part: r.row.part, epic: r.row.epic,
    expected: { serial: r.row.serial }, verdict: r.pdf.ok ? 'pass' : 'fail', reason: r.pdf.reason ?? null
  });
}
log(`Section A: ${swept} constituencies swept, ${sweepFails} site mismatches, ${sweepPdfFails} PDF mismatches\n`);

// -------------------------------------------------- Section B: corner cases

log('=== Section B: corner cases (ASD) ===');
const boundaryAcs = [Math.min(...targetAcs), Math.max(...targetAcs)];
const scanTargets = [...new Set([
  ...boundaryAcs,
  ...[...targetAcs].sort(() => Math.random() - 0.5).slice(0, cornerSamples * 2)
])];
log(`Scanning ${scanTargets.length} constituencies for corner-case candidates…`);
const scans = await pool(scanTargets, concurrency, (ac) => scanAc(ac));
const byAc = new Map(scans.map((s) => [s.ac, s]));

// --- B1: reason-code mix lands in the four known categories ---
log('\n-- B1: reason-code mix (regression guard for the Unicode-normalization bug) --');
const totalReasons = new Map();
for (const s of scans) for (const [code, n] of s.reasonCodes) totalReasons.set(code, (totalReasons.get(code) ?? 0) + n);
const totalRows = [...totalReasons.values()].reduce((a, b) => a + b, 0);
const otherCount = totalReasons.get('OTHER') ?? 0;
log(`  ${JSON.stringify(Object.fromEntries(totalReasons))}`);
if (totalRows && otherCount / totalRows > 0.01) {
  fail(`OTHER reason code is ${(otherCount / totalRows * 100).toFixed(1)}% of sampled rows — `
    + 'expected near-zero; likely a reason-text matching regression');
} else {
  log(`  ok — OTHER is ${totalRows ? (otherCount / totalRows * 100).toFixed(2) : 0}% of ${totalRows} sampled rows`);
}

// --- B2: names actually published (the "include names" schema decision) ---
log('\n-- B2: names are actually present in published records --');
const namedRows = scans.flatMap((s) => [...s.byPart.values()].flat()).filter((r) => r.name || r.relativeName);
const allRows = scans.flatMap((s) => [...s.byPart.values()].flat());
if (!allRows.length) {
  log('  no rows in the scanned ACs — nothing to check');
} else {
  const pct = namedRows.length / allRows.length * 100;
  if (pct < 90) fail(`only ${pct.toFixed(1)}% of sampled rows carry a name — expected near-100%`);
  else log(`  ok — ${pct.toFixed(1)}% of ${allRows.length} sampled rows carry a name`);
}

// --- B3: duplicate EPICs within ASD resolve to exactly one live record ---
log('\n-- B3: duplicate EPICs (within ASD) resolve to exactly one live record --');
const dupPairs = scans.flatMap((s) => s.dupPairs);
if (!dupPairs.length) {
  log(`  none found across the ${scanTargets.length} scanned constituencies`);
} else {
  const sample = [...dupPairs].sort(() => Math.random() - 0.5).slice(0, cornerSamples);
  let b3Fails = 0;
  for (const [first, second] of sample) {
    const hits = await lookupLiveAsd(first.epic, manifest);
    if (hits.length !== 1) {
      b3Fails++;
      fail(`duplicate ASD EPIC ${first.epic} (AC${first.ac}/${first.part} and AC${second.ac}/${second.part}) — `
        + `live site has ${hits.length} hits, expected exactly 1`);
    }
  }
  log(`  ${sample.length - b3Fails}/${sample.length} duplicate EPICs resolved to exactly one record`);
}

// --- B4: sampled cross-list check — EPICs in both ASD and the draft roll ---
log('\n-- B4: sampled cross-list check (ASD EPIC also found on the draft roll) --');
try {
  const rollManifest = await getJson(`${site}/data/manifest.json`);
  const sample = [...allRows].sort(() => Math.random() - 0.5).slice(0, cornerSamples);
  let crossHits = 0;
  for (const row of sample) {
    if (!ROLL_EPIC_RE.test(row.epic)) continue;
    const hits = await lookupLiveRoll(row.epic, rollManifest);
    if (hits.length) {
      crossHits++;
      log(`  found in both: ${row.epic} — ASD says ${row.reasonCode} (AC${row.ac}/${row.part}), `
        + `roll says ${JSON.stringify(hits)}`);
    }
  }
  log(`  ${crossHits}/${sample.length} sampled ASD EPICs also appear on the draft roll `
    + '(this is a light sample, not the full statewide audit — see the dedicated overlap task for that)');
} catch (err) {
  log(`  skipped — could not load the roll manifest: ${err.message}`);
}

// --- B5: boundary constituencies, pushed harder ---
log('\n-- B5: boundary constituencies (lowest & highest AC number) --');
let b5Fails = 0;
let b5Checked = 0;
for (const ac of boundaryAcs) {
  const scan = byAc.get(ac);
  if (!scan || scan.minPart === Infinity) { log(`  AC ${ac}: no rows to test`); continue; }
  for (const part of new Set([scan.minPart, scan.maxPart])) {
    const rows = scan.byPart.get(part) ?? [];
    if (!rows.length) continue;
    const sorted = [...rows].sort((a, b) => a.serial - b.serial);
    for (const row of [sorted[0], sorted[sorted.length - 1]]) {
      b5Checked++;
      const hits = await lookupLiveAsd(row.epic, manifest);
      const match = hits.find((h) => h[1] === row.ac && h[2] === row.part && h[3] === row.serial);
      if (!match) {
        b5Fails++;
        fail(`AC ${ac} (boundary) part ${part} serial ${row.serial} (${row.epic}) — not found live`);
      } else {
        log(`  ok    AC ${ac} part ${part} serial ${row.serial} (edge of booth range)`);
      }
      await logTest({
        dataset: 'asd', layer: 'site-boundary', ac: row.ac, part: row.part, epic: row.epic,
        expected: { ac: row.ac, part: row.part, serial: row.serial },
        actual: hits, verdict: match ? 'pass' : 'fail'
      });
    }
  }
}
log(`B5: ${b5Checked - b5Fails}/${b5Checked} boundary-of-booth records matched\n`);
} // if (targetAcs.length)

log(`=== done — exit ${exitCode === 0 ? 'clean' : 'with failures'} ===`);
process.exitCode = exitCode;
