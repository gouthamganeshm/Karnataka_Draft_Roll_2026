/* Stage 10 — ASD rows to bucket files.
 *
 * Sibling of `3-build-data.mjs`, writing to entirely separate paths:
 *
 *   docs/data-asd/manifest.json      its own coverage stats — never folded
 *                                    into docs/data/manifest.json, so the
 *                                    roll's 99% negative-verdict rule never
 *                                    runs against the wrong denominator
 *   docs/data-asd/roll/<ab>/<cd>.json  same hash-bucket layout as the roll's
 *                                    own docs/data/roll/, so app.js's binary
 *                                    search works unchanged against it
 *
 * `docs/data-asd` is a *sibling* of `docs/data`, deliberately not a child of
 * it — see the ASD_DATA constant below for why that placement is load-bearing,
 * not stylistic.
 *
 * Reads `cache/asd-rows/<ac>.jsonl` — never `cache/rows/`. This script does
 * not import from, write to, or otherwise touch anything under the draft
 * roll's own cache or docs/data/roll/ tree. That separation is a deliberate
 * requirement (OBSERVATIONS-ASD.md §6, reaffirmed directly by the user), not
 * an incidental choice — do not "simplify" the two pipelines into one.
 *
 * Full rebuild only, unlike stage 3. The ASD dataset is a fixed ~12M rows
 * (OBSERVATIONS-ASD.md §1's projection) against the roll's ~44M, comfortably
 * inside a full in-memory pass without the roll's checkpoint machinery. Add
 * incremental building here if publish cadence ever makes that costly.
 *
 *     node scripts/10-build-asd-data.mjs
 *     node scripts/10-build-asd-data.mjs --ac 1,2,209
 */

import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import {
  CACHE, ROOT, fmtBytes, log, progress, readJson, sha256hex, writeJson
} from './lib/common.mjs';

const ASD_ROWS = resolve(CACHE, 'asd-rows');
// Deliberately a *sibling* of docs/data, not a child of it (docs/data-asd,
// not docs/data/asd). The roll's own 3-build-data.mjs does `rm(DATA, {
// recursive: true })` — DATA being the whole docs/data tree — on every full
// rebuild (a real, periodic occurrence: see HANDOFF.md's checkpoint-mismatch
// incident). A subdirectory under docs/data would get silently deleted the
// next time that fires. Being a sibling means the roll pipeline's rm() can
// never reach this tree no matter what it does inside its own directory.
const ASD_DATA = resolve(ROOT, 'docs', 'data-asd');

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const onlyAcs = argValue('--ac')?.split(',').map((s) => +s.trim());

const TARGET_PER_BUCKET = 600;
const SUFFIX = 8;
// Every ASD-side row not matching this is dropped, never published as a
// guess — this text layer is exact, so a row failing this is an extraction
// artifact, not something confidence-scoring should try to save (see
// asd_parser.py's own header comment on why this grammar is never coerced).
const EPIC_RE = /^[A-Z]{3}[0-9]{7,8}$/;

const bucketPath = (prefix) => (prefix.length > 2
  ? resolve(ASD_DATA, 'roll', prefix.slice(0, 2), `${prefix.slice(2)}.json`)
  : resolve(ASD_DATA, 'roll', `${prefix}.json`));

const sortBySuffix = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

const manifestIn = await readJson(resolve(CACHE, 'manifest.json'));
if (!manifestIn) {
  log('cache/manifest.json missing. Run `npm run discover` first.');
  process.exit(1);
}

let rowFiles;
try {
  rowFiles = (await readdir(ASD_ROWS)).filter((f) => f.endsWith('.jsonl'));
} catch {
  log(`No rows in ${ASD_ROWS}. Run \`python scripts/9-extract-asd.py\` first.`);
  process.exit(1);
}
if (onlyAcs) rowFiles = rowFiles.filter((f) => onlyAcs.includes(+f.replace('.jsonl', '')));
if (!rowFiles.length) {
  log('Nothing to build.');
  process.exit(1);
}

log(`Counting ASD rows across ${rowFiles.length} constituencies…`);
let total = 0;
for (const file of rowFiles) {
  let n = 0;
  const rl = createInterface({ input: createReadStream(resolve(ASD_ROWS, file)), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) n++;
  total += n;
  progress(`  ${file}: ${total} so far`);
}
progress('');
log(`${total} ASD rows`);

const shardDepth = Math.min(4, Math.max(1,
  Math.round(Math.log(Math.max(total, 1) / TARGET_PER_BUCKET) / Math.log(16))
));
log(`Bucket depth ${shardDepth} (${16 ** shardDepth} buckets, ~${Math.round(total / 16 ** shardDepth)} each)`);

log(onlyAcs ? `Rebuilding ${onlyAcs.length} constituencies…` : 'Full rebuild…');

const buckets = new Map();
const bucketSuffixes = new Map(); // per-prefix Set, same reason as 3-build-data.mjs: V8's 2^24 cap on one big Set
const acStats = {};
const partNames = new Map(); // acNo -> Map(partNo -> name), from the ASD PDF's own header
let electors = 0;
let duplicates = 0;
let malformed = 0;
let built = 0;

if (!onlyAcs) {
  await rm(ASD_DATA, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 });
}
await mkdir(resolve(ASD_DATA, 'parts'), { recursive: true });

for (const file of rowFiles) {
  const acNo = +file.replace('.jsonl', '');
  const parts = {};

  const rl = createInterface({ input: createReadStream(resolve(ASD_ROWS, file)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const epic = String(row.epic ?? '').trim().toUpperCase();
    const partNo = +row.part || 0;

    if (!row.ok || !EPIC_RE.test(epic)) { malformed++; continue; }

    const hash = sha256hex(epic);
    const prefix = hash.slice(0, shardDepth);
    const suffix = hash.slice(shardDepth, shardDepth + SUFFIX);

    let suffixSet = bucketSuffixes.get(prefix);
    if (!suffixSet) { suffixSet = new Set(); bucketSuffixes.set(prefix, suffixSet); }
    if (suffixSet.has(suffix)) { duplicates++; continue; }
    suffixSet.add(suffix);
    electors++;

    if (!buckets.has(prefix)) buckets.set(prefix, []);
    // [suffix, ac, part, serial, reasonCode, oldPart, oldSerial, name, relativeName]
    buckets.get(prefix).push([
      suffix, acNo, partNo, +row.serial || 0, row.reasonCode || 'OTHER',
      +row.oldPart || 0, +row.oldSerial || 0, row.name || '', row.relativeName || ''
    ]);

    const stat = acStats[acNo] ?? (acStats[acNo] = { rows: 0, partsSeen: [] });
    stat.rows++;
    if (!parts[partNo]) parts[partNo] = true;

    if (++built % 100000 === 0) progress(`  ${built}/${total}`);
  }

  if (!onlyAcs || onlyAcs.includes(acNo)) {
    partNames.set(acNo, new Map());
  }
}
progress('');

// A second pass to record which parts were actually read (including 404s,
// which are zero-row successful reads — see 9-extract-asd.py) and to pick up
// booth names from the ASD done ledger's own extraction pass is not available
// here since the row file only carries parts with >0 rows; partsSeen instead
// comes from cache/asd-done/<ac>.txt, the same source of truth stage 9 itself
// uses for resumability.
const ASD_DONE = resolve(CACHE, 'asd-done');
let doneFiles;
try {
  doneFiles = (await readdir(ASD_DONE)).filter((f) => f.endsWith('.txt'));
} catch {
  doneFiles = [];
}
for (const file of doneFiles) {
  const acNo = +file.replace('.txt', '');
  if (onlyAcs && !onlyAcs.includes(acNo)) continue;
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(resolve(ASD_DONE, file), 'utf8');
  const partsSeen = text.split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
  const stat = acStats[acNo] ?? (acStats[acNo] = { rows: 0, partsSeen: [] });
  stat.partsSeen = [...new Set(partsSeen)];
}

log(`\nWriting ${buckets.size} buckets…`);
let bytes = 0;
let written = 0;
for (const [prefix, records] of buckets) {
  records.sort(sortBySuffix);
  const path = bucketPath(prefix);
  await mkdir(resolve(path, '..'), { recursive: true });
  const json = JSON.stringify(records);
  await writeFile(path, json);
  bytes += json.length;
  if (++written % 500 === 0) progress(`  ${written}/${buckets.size}`);
}
progress('');

const acs = {};
let partsTotal = 0;
let partsDone = 0;
for (const ac of manifestIn.constituencies) {
  if (onlyAcs && !onlyAcs.includes(ac.acNumber)) continue;
  const stat = acStats[ac.acNumber];
  const expected = ac.parts.length;
  const done = stat ? stat.partsSeen.length : 0;
  partsTotal += expected;
  partsDone += done;
  acs[ac.acNumber] = {
    name: ac.name, nameKn: ac.nameKn, district: ac.district,
    parts: expected, partsDone: done, rows: stat ? stat.rows : 0
  };
}
const coverage = partsTotal ? (partsDone / partsTotal) * 100 : 0;

await writeJson(resolve(ASD_DATA, 'manifest.json'), {
  state: manifestIn.state,
  builtAt: new Date().toISOString(),
  shardDepth,
  suffixLength: SUFFIX,
  rows: electors,
  constituencies: Object.keys(acs).length,
  parts: partsTotal,
  partsDone,
  coverage: +coverage.toFixed(2),
  acs
}, true);

log(`\nWrote ${buckets.size} ASD buckets (${fmtBytes(bytes)}) to ${ASD_DATA}`);
log(`  ${electors} ASD rows, ${Object.keys(acStats).length} constituencies, ${partsDone}/${partsTotal} booths (${coverage.toFixed(1)}%)`);
if (duplicates) log(`  ${duplicates} duplicate EPICs skipped`);
if (malformed) log(`  ${malformed} rows withheld (malformed EPIC or unparsed row)`);
