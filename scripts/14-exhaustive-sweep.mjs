#!/usr/bin/env node
/* Stage 14 — exhaustive, per-booth sweep, both datasets, with a full test
 * log book. Explicit user request: not "one booth per constituency" like
 * 8-full-sweep.mjs / 12-full-sweep-asd.mjs, but EVERY booth, both the
 * live-site lookup and a source-PDF re-verification — and every single test
 * recorded with a timestamp, expected vs. actual, to
 * cache/exhaustive-test-log.jsonl. `--samples` defaults to **1** record per
 * booth (scaled down from an initial 5 once the roll dataset's realistic
 * multi-day PDF-recheck cost was measured — see below); raise it with
 * `--samples N` if the slower run is wanted.
 *
 * Built to survive being interrupted across a multi-day run:
 *   - a booth's PDF is fetched ONCE and every one of its samples is checked
 *     against that one parse (not one fetch per sample — the CDN is the
 *     bottleneck, see HANDOFF.md §4e)
 *   - completed booths are recorded in a done-ledger and skipped on restart,
 *     the same resumability pattern as the extraction stages
 *   - the log is appended, never rewritten, so a crash loses at most the one
 *     booth mid-flight
 *
 *     node scripts/14-exhaustive-sweep.mjs --dataset roll
 *     node scripts/14-exhaustive-sweep.mjs --dataset asd
 *     node scripts/14-exhaustive-sweep.mjs --dataset roll --limit 50   # smoke test
 *
 * Realistic cost at --samples 1, measured against this session's own
 * throughput figures:
 *   roll — 60,923 booths x one OCR'd PDF fetch each, ~9-10 parts/min under
 *          real CDN load -> roughly 4 days, continuous (this is the actual
 *          bottleneck; more samples per booth do not add more PDF fetches,
 *          see above, but do add live-site lookups, which are cheap)
 *   asd  — ~60,736 booths with data x one text-layer parse each, ~700
 *          parts/min demonstrated -> roughly 1.5 hours
 * Run the ASD dataset first if you want a result sooner; the roll dataset is
 * the one that actually needs the multi-day budget.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { CACHE, log, logTest, pool, readJson } from './lib/common.mjs';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const dataset = argValue('--dataset');
if (dataset !== 'roll' && dataset !== 'asd') {
  log('Usage: node scripts/14-exhaustive-sweep.mjs --dataset roll|asd [--limit N] [--concurrency N] [--samples N]');
  process.exit(2);
}
const limit = argValue('--limit') ? Number(argValue('--limit')) : null;
const concurrency = Number(argValue('--concurrency') ?? 8);
const samplesPerBooth = Number(argValue('--samples') ?? 1);
const site = argValue('--site') ?? 'https://gouthamganeshm.github.io/Karnataka_Draft_Roll_2026';

const UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
const ROLL_CDN = 'https://voters.eci.gov.in/eroll/2026/s10/sir-draftroll';
const ASD_CDN = 'https://voters.eci.gov.in/eroll/asd/2026/s10';
const rollPartUrl = (ac, part) =>
  `${ROLL_CDN}/${ac}/2026-EROLLGEN-S10-${ac}-SIR-DraftRoll-Revision1-KAN-${part}-WI.pdf`;
const asdPartUrl = (ac, part) => `${ASD_CDN}/${ac}/uncollectable_elector_report_ac${ac}_part${part}_KAN.pdf`;

const ROWS_DIR = resolve(CACHE, dataset === 'roll' ? 'rows' : 'asd-rows');
const DATA_BASE = dataset === 'roll' ? 'data' : 'data-asd';
const DONE_LEDGER = resolve(CACHE, `exhaustive-done-${dataset}.txt`);

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
  const p = getJson(`${site}/${DATA_BASE}/${path}`).catch(() => null);
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

/** Promise-based spawn, matching spawnSync's {status, stdout, stderr} shape.
 * Load-bearing, not a style choice: spawnSync blocks Node's entire
 * single-threaded event loop until the subprocess exits, which silently
 * serializes every "concurrent" pool() worker onto whichever one currently
 * holds it — with --concurrency 10 this measured ~52-55 booths/min instead
 * of anything near the ~700/min the ASD text-layer parse is capable of.
 * Caught by the throughput itself looking wrong, not by reasoning about it
 * in advance. */
function spawnAsync(cmd, args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args);
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (d) => stdout.push(d));
    child.stderr.on('data', (d) => stderr.push(d));
    child.on('error', reject);
    child.on('close', (status) => {
      resolvePromise({ status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.on('error', () => { /* EPIPE if the process exits before stdin drains — status still reported via close */ });
    child.stdin.end(input);
  });
}

/** One PDF fetch per booth, all samplesPerBooth rows checked against it. */
async function verifyBoothAgainstPdf(ac, part, rows) {
  const url = dataset === 'roll' ? rollPartUrl(ac, part) : asdPartUrl(ac, part);
  let buf;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://voters.eci.gov.in/' } });
      if (!res.ok) return rows.map((r) => ({ row: r, ok: false, reason: `PDF fetch ${res.status}` }));
      buf = Buffer.from(await res.arrayBuffer());
      break;
    } catch (err) {
      if (attempt === 3) return rows.map((r) => ({ row: r, ok: false, reason: `PDF fetch failed 3x: ${err.message}` }));
      await new Promise((r2) => setTimeout(r2, 2000 * attempt));
    }
  }

  const epicsJson = JSON.stringify(rows.map((r) => r.epic));
  const script = dataset === 'roll'
    ? `
import sys, json
sys.path.insert(0, 'scripts/ocr')
from roll_ocr import read_part_bytes
data = sys.stdin.buffer.read()
rows = read_part_bytes(data)
byEpic = {r.epic: r for r in rows}
wanted = json.loads('''${epicsJson}''')
out = []
for e in wanted:
    r = byEpic.get(e)
    out.append({'found': r is not None, 'serial': r.serial if r else None})
print(json.dumps(out))
`
    : `
import sys, json
sys.path.insert(0, 'scripts/ocr')
from asd_parser import read_asd_bytes
data = sys.stdin.buffer.read()
rows, header = read_asd_bytes(data)
byEpic = {r.epic: r for r in rows}
wanted = json.loads('''${epicsJson}''')
out = []
for e in wanted:
    r = byEpic.get(e)
    out.append({
      'found': r is not None, 'serial': r.serial if r else None,
      'reasonCode': r.reasonCode if r else None,
      'oldPart': r.oldPart if r else None, 'oldSerial': r.oldSerial if r else None,
      'name': r.name if r else None, 'relativeName': r.relativeName if r else None
    })
print(json.dumps(out))
`;
  const r = await spawnAsync('python', ['-c', script], buf);
  if (r.status !== 0) {
    const reason = `python exit ${r.status}: ${r.stderr?.toString().slice(-300)}`;
    return rows.map((row) => ({ row, ok: false, reason }));
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout.toString().trim().split('\n').pop());
  } catch {
    return rows.map((row) => ({ row, ok: false, reason: 'could not parse re-check output' }));
  }
  return rows.map((row, i) => {
    const p = parsed[i];
    if (!p || !p.found) return { row, ok: false, reason: 'EPIC not found on re-read' };
    if (p.serial !== row.serial) return { row, ok: false, reason: `serial mismatch: expected ${row.serial}, re-read ${p.serial}` };
    if (dataset === 'asd') {
      const mismatches = [];
      if (p.reasonCode !== row.reasonCode) mismatches.push('reasonCode');
      if (p.oldPart !== row.oldPart) mismatches.push('oldPart');
      if (p.oldSerial !== row.oldSerial) mismatches.push('oldSerial');
      if (p.name !== row.name) mismatches.push('name');
      if (p.relativeName !== row.relativeName) mismatches.push('relativeName');
      if (mismatches.length) return { row, ok: false, reason: `field mismatch: ${mismatches.join(',')}` };
    }
    return { row, ok: true };
  });
}

function pickSamples(rows, n) {
  const shuffled = [...rows].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

const logEntry = (entry) => logTest({ dataset, ...entry });

/** All (ac, part) booths in scope, from the manifest — not the row files, so
 * a booth with zero rows (a genuine ASD 404) is still counted and skipped
 * deliberately, not silently absent from the sweep's own accounting. */
async function loadBooths() {
  const manifest = await readJson(resolve(CACHE, 'manifest.json'));
  const booths = [];
  for (const ac of manifest.constituencies) {
    for (const part of ac.parts) booths.push({ ac: ac.acNumber, part: part.partNumber });
  }
  return booths;
}

async function loadAcRows(ac) {
  const path = resolve(ROWS_DIR, `${ac}.jsonl`);
  const byPart = new Map();
  let rl;
  try {
    rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  } catch {
    return byPart;
  }
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row.ok) continue;
    row.epic = String(row.epic).trim().toUpperCase();
    if (!byPart.has(row.part)) byPart.set(row.part, []);
    byPart.get(row.part).push(row);
  }
  return byPart;
}

// ------------------------------------------------------------------------ run

await mkdir(CACHE, { recursive: true });
let done = new Set();
try {
  done = new Set((await readFile(DONE_LEDGER, 'utf8')).split('\n').filter(Boolean));
} catch { /* first run */ }

log(`Fetching live manifest (${dataset})…`);
const manifest = await getJson(`${site}/${DATA_BASE}/manifest.json`);

let booths = await loadBooths();
booths = booths.filter((b) => !done.has(`${b.ac}:${b.part}`));
booths = [...booths].sort(() => Math.random() - 0.5); // fresh random order every run
if (limit) booths = booths.slice(0, limit);

log(`${booths.length} booths remaining (dataset=${dataset}, ${done.size} already done from a prior run).`);
if (!booths.length) { log('Nothing left to sweep.'); process.exit(0); }

let swept = 0;
let siteFails = 0;
let pdfFails = 0;
let started = Date.now();

const markDone = (ac, part) => appendFile(DONE_LEDGER, `${ac}:${part}\n`);

await pool(booths, concurrency, async ({ ac, part }) => {
  // Deliberately not cached across booths: with `concurrency` workers
  // pulling from a randomly-shuffled booth list, a shared cache would need
  // to hold most of the state's 224 ACs' row data at once within minutes —
  // the same scale that hit a JS heap ceiling earlier in this project (see
  // HANDOFF.md's bug 2). The PDF fetch+OCR below dominates runtime by one to
  // two orders of magnitude anyway, so re-reading a single AC's JSONL per
  // booth costs nothing that matters.
  const byPart = await loadAcRows(ac);
  const rows = byPart.get(part) ?? [];
  if (!rows.length) {
    await markDone(ac, part);
    return;
  }
  const samples = pickSamples(rows, samplesPerBooth);

  // Layer 1: live-site consistency, all samples.
  for (const row of samples) {
    const hits = await lookupLive(row.epic, manifest);
    const match = dataset === 'roll'
      ? hits.find((h) => h[1] === row.ac && h[2] === row.part && h[3] === row.serial)
      : hits.find((h) => h[1] === row.ac && h[2] === row.part && h[3] === row.serial
          && h[4] === row.reasonCode && h[5] === row.oldPart && h[6] === row.oldSerial);
    const ok = Boolean(match);
    if (!ok) siteFails++;
    await logEntry({
      layer: 'site', ac, part, epic: row.epic,
      expected: dataset === 'roll'
        ? { ac: row.ac, part: row.part, serial: row.serial }
        : { ac: row.ac, part: row.part, serial: row.serial, reasonCode: row.reasonCode, oldPart: row.oldPart, oldSerial: row.oldSerial },
      actual: hits,
      verdict: ok ? 'pass' : 'fail'
    });
  }

  // Layer 2: source PDF, one fetch for the whole booth.
  const pdfResults = await verifyBoothAgainstPdf(ac, part, samples);
  for (const { row, ok, reason } of pdfResults) {
    if (!ok) pdfFails++;
    await logEntry({
      layer: 'pdf', ac, part, epic: row.epic,
      expected: dataset === 'roll'
        ? { serial: row.serial }
        : { serial: row.serial, reasonCode: row.reasonCode, oldPart: row.oldPart, oldSerial: row.oldSerial, name: row.name, relativeName: row.relativeName },
      verdict: ok ? 'pass' : 'fail',
      reason: reason ?? null
    });
  }

  await markDone(ac, part);
  swept++;
  if (swept % 25 === 0) {
    const rate = swept / ((Date.now() - started) / 60000);
    log(`  [${swept}/${booths.length}] ${siteFails} site fails, ${pdfFails} pdf fails, ${rate.toFixed(1)} booths/min`);
  }
});

log(`\nDone. ${swept} booths swept, ${siteFails} site-layer fails, ${pdfFails} pdf-layer fails.`);
log('Full log: test-logs/test-log.jsonl');
process.exitCode = (siteFails || pdfFails) ? 1 : 0;
