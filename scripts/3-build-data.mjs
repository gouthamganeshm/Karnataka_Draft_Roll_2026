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
 *   node scripts/3-build-data.mjs --full     # force a from-scratch rebuild
 *
 * ## Incremental builds
 *
 * `roll/<ab>/<cd>.json` is bucketed by SHA-256(EPIC), spread evenly across
 * every constituency in the state — that is what lets a voter search by EPIC
 * without knowing their own AC. The cost is that new rows from even one AC
 * land in a near-random scatter of buckets, so a from-scratch rebuild every
 * publish cycle touches nearly all ~65,536 bucket files regardless of how
 * little actually changed. At full scale that meant `git add` alone was
 * taking minutes and, with 65,536+ files needing to be listed for the commit
 * message, once actually crashed `git ls-files` with ENOBUFS on Windows.
 *
 * So this stage now keeps a checkpoint (`cache/build-state.json`) of, per
 * constituency, how many rows have already been folded into the published
 * buckets. A run only re-reads the *new* lines in a changed constituency's
 * JSONL, and only touches the specific buckets those new EPICs hash into —
 * everything else on disk is left completely alone. `--ac` and `--full` both
 * bypass this and force a full rebuild, and a full rebuild is also the
 * automatic fallback whenever the checkpoint looks stale or missing (first
 * run ever, `docs/data` was deleted or edited outside this script, or the
 * bucket depth needs to change because the state has grown enough to need
 * finer sharding). Incremental and full builds share the exact same
 * acceptance rules (a row needs `ok` and a well-formed EPIC) and the same
 * manifest-writing code, so they cannot silently diverge in what counts as a
 * valid record.
 */

import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import {
  CACHE, DATA, fmtBytes, log, progress, readJson, sha256hex, writeJson
} from './lib/common.mjs';

const ROWS = resolve(CACHE, 'rows');
const STATE_PATH = resolve(CACHE, 'build-state.json');

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const onlyAcs = argValue('--ac')?.split(',').map((s) => +s.trim());
const forceFull = args.includes('--full');

// Karnataka's SIR 2026 calendar, from the CEO's published schedule. These drive
// the deadline banner and the wording of a negative verdict, so they live with
// the data rather than being hard-coded in the client.
const PUBLISHED_AT = '2026-08-24';
const CLAIMS_CLOSE_AT = '2026-09-23';

const TARGET_PER_BUCKET = 600;
const SUFFIX = 8;

const bucketPath = (prefix) => (prefix.length > 2
  ? resolve(DATA, 'roll', prefix.slice(0, 2), `${prefix.slice(2)}.json`)
  : resolve(DATA, 'roll', `${prefix}.json`));

const sortBySuffix = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

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

// ------------------------------------------------------------ count lines

// Line-count only, no JSON.parse — cheap even at full state size, and it is
// what both decides the bucket depth and tells us which constituencies have
// grown since the last build.
async function countLines(path) {
  let n = 0;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) n++;
  return n;
}

log(`Counting electors across ${rowFiles.length} constituencies…`);
const lineCounts = {};
let total = 0;
for (const file of rowFiles) {
  const acNo = +file.replace('.jsonl', '');
  const n = await countLines(resolve(ROWS, file));
  lineCounts[acNo] = n;
  total += n;
  progress(`  ${file}: ${total} so far`);
}
progress('');
log(`${total} elector rows`);

// Aim for ~600 records a bucket: small enough that a lookup downloads a few
// tens of KB, large enough that the bucket count stays in the tens of
// thousands.
const shardDepth = Math.min(4, Math.max(1,
  Math.round(Math.log(total / TARGET_PER_BUCKET) / Math.log(16))
));
log(`Bucket depth ${shardDepth} (${16 ** shardDepth} buckets, ~${Math.round(total / 16 ** shardDepth)} each)`);

// ------------------------------------------------------- incremental? full?

const state = onlyAcs ? null : await readJson(STATE_PATH);
const existingManifest = onlyAcs ? null : await readJson(resolve(DATA, 'manifest.json'));

const canIncremental = Boolean(
  !forceFull && !onlyAcs && state && existingManifest &&
  state.shardDepth === shardDepth &&
  state.suffixLength === SUFFIX &&
  state.electors === existingManifest.electors &&
  Object.keys(lineCounts).every((ac) => (state.acLineCounts[ac] ?? 0) <= lineCounts[ac])
);

// -------------------------------------------------------- shared: manifest

async function writeManifest(acStats, electors) {
  const acs = {};
  let partsTotal = 0;
  let partsDone = 0;
  for (const ac of manifestIn.constituencies) {
    const stat = acStats[ac.acNumber];
    const expected = ac.parts.length;
    const done = stat ? stat.partsSeen.length : 0;
    partsTotal += expected;
    partsDone += done;
    acs[ac.acNumber] = {
      name: ac.name,
      nameKn: ac.nameKn,
      district: ac.district,
      parts: expected,
      partsDone: done,
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
    electors,
    constituencies: Object.keys(acs).length,
    parts: partsTotal,
    partsDone,
    coverage: +coverage.toFixed(2),
    acs
  }, true);
  return { partsTotal, partsDone, coverage };
}

// ------------------------------------------------------------------------

if (!canIncremental) {
  // ---------------------------------------------------------- full rebuild

  log(forceFull || onlyAcs ? 'Full rebuild (requested)…' : 'Full rebuild (no usable checkpoint)…');

  const buckets = new Map();
  const acStats = {};
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

      // A row the OCR could not vouch for is counted toward the part's
      // coverage shortfall, never published as a record. Publishing a
      // misread EPIC would tell one person they are on the roll and another
      // that they are not.
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

      const stat = acStats[acNo] ?? (acStats[acNo] = { electors: 0, partsSeen: [] });
      stat.electors++;
      if (!stat.partsSeen.includes(partNo)) stat.partsSeen.push(partNo);

      if (++built % 100000 === 0) progress(`  ${built}/${total}`);
    }

    if (!onlyAcs || onlyAcs.includes(acNo)) {
      await writeJson(resolve(DATA, 'parts', `${acNo}.json`), parts);
    }
  }
  progress('');

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

  const { partsTotal, partsDone, coverage } = await writeManifest(acStats, seen.size);

  log(`\nWrote ${buckets.size} buckets (${fmtBytes(bytes)}) to ${DATA}`);
  log(`  ${seen.size} electors, ${Object.keys(acStats).length} constituencies, ${partsDone}/${partsTotal} booths (${coverage.toFixed(1)}%)`);
  if (duplicates) log(`  ${duplicates} duplicate EPICs skipped`);
  if (lowConfidence) log(`  ${lowConfidence} rows withheld as low-confidence (${(lowConfidence / total * 100).toFixed(1)}%)`);

  // A partial `--ac`/`--full` run against a subset does not describe the
  // whole state, so it cannot seed a checkpoint later runs would trust.
  if (!onlyAcs) {
    await writeJson(STATE_PATH, {
      shardDepth,
      suffixLength: SUFFIX,
      electors: seen.size,
      duplicates,
      lowConfidence,
      acLineCounts: lineCounts,
      acStats
    });
  }
} else {
  // ----------------------------------------------------- incremental build

  const changedAcs = rowFiles
    .map((f) => +f.replace('.jsonl', ''))
    .filter((ac) => lineCounts[ac] > (state.acLineCounts[ac] ?? 0));

  if (!changedAcs.length) {
    log('Nothing new since the last build.');
    process.exit(0);
  }

  log(`Incremental build — ${changedAcs.length} constituencies have new rows since the last build.`);

  const candidatesByPrefix = new Map();
  let scannedLowConfidence = 0;

  for (const ac of changedAcs) {
    const startLine = state.acLineCounts[ac] ?? 0;
    const rl = createInterface({
      input: createReadStream(resolve(ROWS, `${ac}.jsonl`)),
      crlfDelay: Infinity
    });
    let lineIdx = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      lineIdx++;
      if (lineIdx <= startLine) continue;

      const row = JSON.parse(line);
      const epic = String(row.epic ?? '').trim().toUpperCase();
      const partNo = +row.part || 0;
      if (!row.ok || !/^[A-Z]{3}[0-9]{7}$/.test(epic)) { scannedLowConfidence++; continue; }

      const hash = sha256hex(epic);
      const prefix = hash.slice(0, shardDepth);
      if (!candidatesByPrefix.has(prefix)) candidatesByPrefix.set(prefix, []);
      candidatesByPrefix.get(prefix).push({
        suffix: hash.slice(shardDepth, shardDepth + SUFFIX),
        acNo: ac,
        partNo,
        serial: +row.serial || 0,
        partName: row.partName ? String(row.partName).trim() : ''
      });
    }
    state.acLineCounts[ac] = lineCounts[ac];
  }

  log(`Merging ${candidatesByPrefix.size} touched buckets (of ${16 ** shardDepth})…`);
  let scannedDuplicates = 0;
  let scannedElectors = 0;
  const touchedAcParts = new Map();

  let written = 0;
  for (const [prefix, candidates] of candidatesByPrefix) {
    const path = bucketPath(prefix);
    const existing = await readJson(path, []);
    const suffixesHere = new Set(existing.map((r) => r[0]));
    const merged = existing.slice();

    for (const c of candidates) {
      // The same EPIC can appear in two parts when a transfer is mid-flight —
      // and because SHA-256(EPIC) is deterministic, "already in this bucket"
      // is exactly the cross-constituency duplicate check the full-rebuild
      // path does with a single statewide `seen` set, just scoped to the one
      // bucket this EPIC could ever land in.
      if (suffixesHere.has(c.suffix)) { scannedDuplicates++; continue; }
      suffixesHere.add(c.suffix);
      merged.push([c.suffix, c.acNo, c.partNo, c.serial]);
      scannedElectors++;

      const stat = state.acStats[c.acNo] ?? (state.acStats[c.acNo] = { electors: 0, partsSeen: [] });
      stat.electors++;
      if (!stat.partsSeen.includes(c.partNo)) stat.partsSeen.push(c.partNo);

      if (c.partName) {
        if (!touchedAcParts.has(c.acNo)) touchedAcParts.set(c.acNo, new Map());
        const m = touchedAcParts.get(c.acNo);
        if (!m.has(c.partNo)) m.set(c.partNo, c.partName);
      }
    }

    merged.sort(sortBySuffix);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(merged));
    if (++written % 200 === 0) progress(`  ${written}/${candidatesByPrefix.size}`);
  }
  progress('');

  for (const [ac, nameMap] of touchedAcParts) {
    const existingParts = await readJson(resolve(DATA, 'parts', `${ac}.json`), {});
    for (const [partNo, name] of nameMap) if (!existingParts[partNo]) existingParts[partNo] = name;
    await writeJson(resolve(DATA, 'parts', `${ac}.json`), existingParts);
  }

  const newElectorsTotal = state.electors + scannedElectors;
  state.electors = newElectorsTotal;
  state.duplicates = (state.duplicates ?? 0) + scannedDuplicates;
  state.lowConfidence = (state.lowConfidence ?? 0) + scannedLowConfidence;

  const { partsTotal, partsDone, coverage } = await writeManifest(state.acStats, newElectorsTotal);

  log(`\nTouched ${candidatesByPrefix.size} buckets to add ${scannedElectors} new electors across ${changedAcs.length} constituencies`);
  log(`  ${newElectorsTotal} electors total, ${Object.keys(state.acStats).length} constituencies, ${partsDone}/${partsTotal} booths (${coverage.toFixed(1)}%)`);
  if (scannedDuplicates) log(`  ${scannedDuplicates} duplicate EPICs skipped this build`);
  if (scannedLowConfidence) log(`  ${scannedLowConfidence} rows withheld as low-confidence this build`);

  await writeJson(STATE_PATH, state);
}
