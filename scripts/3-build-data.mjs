/* Stage 3 — rows to bucket files.
 *
 * Reads the JSONL stage 2 wrote, one file per constituency, and emits the
 * static tree the site reads:
 *
 *   data/manifest.json        counts, coverage, AC names
 *   data/roll/<ab>/<cd>.json  records, sorted by hash suffix so the client can
 *                             binary-search them
 *   data/parts/<ac>.json      part number -> polling booth name
 *
 * A record is
 *
 *   [hash8, acNo, partNo, serial]
 *
 * and carries no EPIC. The browser already knows the number the user typed, so
 * it can render it; publishing it would turn this into a scrapeable
 * EPIC-to-elector table, which is exactly what it must not become.
 *
 * There is no name field because the OCR stage deliberately does not read one —
 * see the README. That keeps records to four small values, which is what makes
 * a ~5.5 crore-row dataset fit in a few gigabytes.
 *
 *   node scripts/3-build-data.mjs
 *   node scripts/3-build-data.mjs --ac 1,2,209
 */

import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import {
  CACHE, DATA, fmtBytes, log, progress, readJson, sha256hex, writeJson
} from './lib/common.mjs';

const ROWS = resolve(CACHE, 'rows');
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const onlyAcs = argValue('--ac')?.split(',').map((s) => +s.trim());

/* Karnataka's SIR 2026 calendar, from the CEO's published schedule. These drive
 * the deadline banner and the wording of a negative verdict, so they live with
 * the data rather than being hard-coded in the client. */
const PUBLISHED_AT = '2026-08-24';
const CLAIMS_CLOSE_AT = '2026-09-23';

const manifestIn = await readJson(resolve(CACHE, 'manifest.json'));
if (!manifestIn) {
  log('cache/manifest.json missing. Run `npm run discover` first.');
  process.exit(1);
}

let rowFiles;
try {
  rowFiles = (await readdir(ROWS)).filter((f) => f.endsWith('.jsonl'));
} catch {
  log(`No rows in ${ROWS}. Run \`python scripts/2-extract.py\` first.`);
  process.exit(1);
}
if (onlyAcs) rowFiles = rowFiles.filter((f) => onlyAcs.includes(+f.replace('.jsonl', '')));
if (!rowFiles.length) {
  log('Nothing to build.');
  process.exit(1);
}

// ------------------------------------------------------------ pass 1: count

log(`Counting electors across ${rowFiles.length} constituencies…`);
let total = 0;
for (const file of rowFiles) {
  const rl = createInterface({ input: createReadStream(resolve(ROWS, file)), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) total++;
  progress(`  ${file}: ${total} so far`);
}
progress('');
log(`${total} elector rows`);

/* Aim for ~600 records a bucket: small enough that a lookup downloads a few tens
 * of KB, large enough that the bucket count stays in the tens of thousands. */
const TARGET_PER_BUCKET = 600;
const shardDepth = Math.min(4, Math.max(1,
  Math.round(Math.log(total / TARGET_PER_BUCKET) / Math.log(16))
));
const SUFFIX = 8;
log(`Bucket depth ${shardDepth} (${16 ** shardDepth} buckets, ~${Math.round(total / 16 ** shardDepth)} each)`);

// ------------------------------------------------------------ pass 2: build

const buckets = new Map();
const acStats = new Map();
const seen = new Set();
let duplicates = 0;
let lowConfidence = 0;
let built = 0;

await rm(DATA, { recursive: true, force: true });
await mkdir(resolve(DATA, 'parts'), { recursive: true });

for (const file of rowFiles) {
  const acNo = +file.replace('.jsonl', '');
  const parts = {};

  const rl = createInterface({ input: createReadStream(resolve(ROWS, file)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const epic = String(row.epic ?? '').trim().toUpperCase();
    const partNo = +row.part || 0;

    // A row the OCR could not vouch for is counted toward the part's coverage
    // shortfall, never published as a record. Publishing a misread EPIC would
    // tell one person they are on the roll and another that they are not.
    if (!row.ok || !/^[A-Z]{3}[0-9]{7}$/.test(epic)) { lowConfidence++; continue; }

    // The same EPIC can appear in two parts when a transfer is mid-flight.
    if (seen.has(epic)) { duplicates++; continue; }
    seen.add(epic);

    const hash = sha256hex(epic);
    const prefix = hash.slice(0, shardDepth);
    if (!buckets.has(prefix)) buckets.set(prefix, []);
    buckets.get(prefix).push([
      hash.slice(shardDepth, shardDepth + SUFFIX),
      acNo,
      partNo,
      +row.serial || 0
    ]);

    if (row.partName && !parts[partNo]) parts[partNo] = String(row.partName).trim();

    const stat = acStats.get(acNo) ?? { electors: 0, parts: new Set() };
    stat.electors++;
    stat.parts.add(partNo);
    acStats.set(acNo, stat);

    if (++built % 100000 === 0) progress(`  ${built}/${total}`);
  }

  await writeJson(resolve(DATA, 'parts', `${acNo}.json`), parts);
}
progress('');

// ------------------------------------------------------------ write buckets

log(`\nWriting ${buckets.size} buckets…`);
let bytes = 0;
let written = 0;
for (const [prefix, records] of buckets) {
  records.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const path = prefix.length > 2
    ? resolve(DATA, 'roll', prefix.slice(0, 2), `${prefix.slice(2)}.json`)
    : resolve(DATA, 'roll', `${prefix}.json`);
  await mkdir(resolve(path, '..'), { recursive: true });
  const json = JSON.stringify(records);
  await writeFile(path, json);
  bytes += json.length;
  if (++written % 500 === 0) progress(`  ${written}/${buckets.size}`);
}
progress('');

// ------------------------------------------------------------ manifest

const acs = {};
let partsTotal = 0;
let partsDone = 0;
for (const ac of manifestIn.constituencies) {
  const stat = acStats.get(ac.acNumber);
  const expected = ac.parts.length;
  partsTotal += expected;
  partsDone += stat ? stat.parts.size : 0;
  acs[ac.acNumber] = {
    name: ac.name,
    nameKn: ac.nameKn,
    district: ac.district,
    parts: expected,
    partsDone: stat ? stat.parts.size : 0,
    electors: stat ? stat.electors : 0
  };
}

const coverage = partsTotal ? (partsDone / partsTotal) * 100 : 0;

await writeJson(resolve(DATA, 'manifest.json'), {
  state: manifestIn.state,
  rollType: manifestIn.rollType,
  publishedAt: PUBLISHED_AT,
  claimsCloseAt: CLAIMS_CLOSE_AT,
  builtAt: new Date().toISOString(),
  shardDepth,
  suffixLength: SUFFIX,
  electors: seen.size,
  constituencies: Object.keys(acs).length,
  parts: partsTotal,
  partsDone,
  coverage: +coverage.toFixed(2),
  acs
}, true);

log(`\nWrote ${buckets.size} buckets (${fmtBytes(bytes)}) to ${DATA}`);
log(`  ${seen.size} electors, ${Object.keys(acs).length} constituencies, ${partsDone}/${partsTotal} booths (${coverage.toFixed(1)}%)`);
if (duplicates) log(`  ${duplicates} duplicate EPICs skipped`);
if (lowConfidence) log(`  ${lowConfidence} rows withheld as low-confidence (${(lowConfidence / total * 100).toFixed(1)}%)`);
