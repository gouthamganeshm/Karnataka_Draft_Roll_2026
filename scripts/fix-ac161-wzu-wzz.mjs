#!/usr/bin/env node
/* One-off remediation — corrects AC161's confirmed WZZ->WZU OCR misread.
 *
 * Root cause (see HANDOFF.md "OCR misreads that pass every check"): Tesseract
 * confuses this one glyph shape ("U" read as "Z") on a per-instance basis
 * within AC161's dominant local EPIC prefix. 144 cards checked by hand across
 * 17 different parts, zero exceptions — every WZZ-prefixed card is a true
 * "U" misread, every WZU-prefixed card is already correct. That evidence is
 * specific to AC161; this script does not touch any other AC or any other
 * letter pattern.
 *
 * Two things need correcting, because the bucket tree is addressed by
 * SHA-256(EPIC): the source row cache (so a future full rebuild doesn't
 * reintroduce the bug) and the already-published bucket tree (so the live
 * site is corrected without a full rebuild). A record carries no EPIC (see
 * 3-build-data.mjs's own header comment on why) — moving one means removing
 * its entry from the bucket the WRONG EPIC hashes to and inserting a new
 * entry in the bucket the CORRECT EPIC hashes to. Matched on suffix AND
 * ac/part/serial together, not suffix alone — suffix-only matching was a
 * real bug found and fixed in 13-overlap-audit.mjs (an expected ~41 false
 * matches across 55M rows from pure hash-suffix collision).
 *
 * Only ever touches: cache/rows/161.jsonl, and the specific docs/data bucket
 * files that contain at least one of the corrected records. Nothing else on
 * disk is read for writing.
 *
 *     node scripts/fix-ac161-wzu-wzz.mjs           # apply
 *     node scripts/fix-ac161-wzu-wzz.mjs --dry-run # report only, no writes
 */

import { readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CACHE, ROOT, log, logTest, readJson, sha256hex, writeJson } from './lib/common.mjs';

const DATA = resolve(ROOT, 'docs', 'data');
const AC = 161;
const WRONG_PREFIX = 'WZZ';
const RIGHT_PREFIX = 'WZU';
const dryRun = process.argv.includes('--dry-run');

const manifest = await readJson(resolve(DATA, 'manifest.json'));
const { shardDepth, suffixLength } = manifest;

const bucketPath = (prefix) => (prefix.length > 2
  ? resolve(DATA, 'roll', prefix.slice(0, 2), `${prefix.slice(2)}.json`)
  : resolve(DATA, 'roll', `${prefix}.json`));
const sortBySuffix = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

// ------------------------------------------------------------- read + fix rows

const rowsPath = resolve(CACHE, 'rows', `${AC}.jsonl`);
const rawLines = (await readFile(rowsPath, 'utf8')).split('\n');

const corrections = []; // { part, serial, ok, oldEpic, newEpic }
const newLines = [];
for (const line of rawLines) {
  if (!line.trim()) { newLines.push(line); continue; }
  const row = JSON.parse(line);
  const epic = String(row.epic ?? '').trim().toUpperCase();
  if (epic.startsWith(WRONG_PREFIX)) {
    const newEpic = RIGHT_PREFIX + epic.slice(3);
    corrections.push({ part: row.part, serial: row.serial, ok: row.ok, oldEpic: epic, newEpic });
    row.epic = newEpic;
  }
  newLines.push(JSON.stringify(row));
}

log(`${corrections.length} ${WRONG_PREFIX}->${RIGHT_PREFIX} rows found in cache/rows/${AC}.jsonl`);
if (!corrections.length) { log('Nothing to do.'); process.exit(0); }

// ------------------------------------------------------- patch the bucket tree

const pendingRemovals = new Map(); // filePath -> [{suffix, ac, part, serial}]
const pendingAdditions = new Map(); // filePath -> [record]

for (const c of corrections) {
  const approx = !c.ok;

  const oldHash = sha256hex(c.oldEpic);
  const oldPrefix = oldHash.slice(0, shardDepth);
  const oldSuffix = oldHash.slice(shardDepth, shardDepth + suffixLength);
  const oldFile = bucketPath(oldPrefix);
  if (!pendingRemovals.has(oldFile)) pendingRemovals.set(oldFile, []);
  pendingRemovals.get(oldFile).push({ suffix: oldSuffix, ac: AC, part: c.part, serial: c.serial });

  const newHash = sha256hex(c.newEpic);
  const newPrefix = newHash.slice(0, shardDepth);
  const newSuffix = newHash.slice(shardDepth, shardDepth + suffixLength);
  const newFile = bucketPath(newPrefix);
  const rec = [newSuffix, AC, c.part, c.serial];
  if (approx) rec.push(1);
  if (!pendingAdditions.has(newFile)) pendingAdditions.set(newFile, []);
  pendingAdditions.get(newFile).push(rec);
}

const touchedFiles = new Set([...pendingRemovals.keys(), ...pendingAdditions.keys()]);
log(`${touchedFiles.size} bucket files touched (${corrections.length} corrections, ~2 touches each, some overlap)`);

let removalsApplied = 0;
let removalsNotFound = 0;
let removalsAmbiguous = 0;
let additionsApplied = 0;

for (const file of touchedFiles) {
  let records = await readJson(file, []);
  const removals = pendingRemovals.get(file) ?? [];
  for (const r of removals) {
    const matches = records.filter((rec) =>
      rec[0] === r.suffix && rec[1] === r.ac && rec[2] === r.part && rec[3] === r.serial);
    if (matches.length === 0) { removalsNotFound++; continue; }
    if (matches.length > 1) removalsAmbiguous++; // shouldn't happen; remove all matches anyway
    records = records.filter((rec) =>
      !(rec[0] === r.suffix && rec[1] === r.ac && rec[2] === r.part && rec[3] === r.serial));
    removalsApplied += matches.length;
  }

  const additions = pendingAdditions.get(file) ?? [];
  for (const rec of additions) { records.push(rec); additionsApplied++; }

  records.sort(sortBySuffix);
  if (!dryRun) await writeJson(file, records);
}

log(`Removals: ${removalsApplied} applied, ${removalsNotFound} not found (unexpected if >0), ${removalsAmbiguous} ambiguous (>1 match)`);
log(`Additions: ${additionsApplied} applied`);

if (removalsNotFound > 0) {
  log(`\n${removalsNotFound} corrected row(s) had no matching published record — investigate before trusting the manifest`
    + ` electors count (it should be unchanged: same total, relocated).`);
}

if (dryRun) {
  log('\n--dry-run: no files were written.');
  process.exit(0);
}

// ----------------------------------------------------------- write corrected rows

await copyFile(rowsPath, `${rowsPath}.pre-wzu-wzz-fix.bak`);
await writeFile(rowsPath, newLines.join('\n'));
log(`\ncache/rows/${AC}.jsonl corrected in place (backup at ${AC}.jsonl.pre-wzu-wzz-fix.bak)`);

// manifest electors/coverage is untouched by design (same total record count,
// just relocated) — no rewrite needed unless the counts below disagree.
log(`\nmanifest.json electors count: unchanged (no rewrite needed) — ${removalsApplied} removed, ${additionsApplied} added, `
  + `net ${additionsApplied - removalsApplied >= 0 ? '+' : ''}${additionsApplied - removalsApplied}`);

await logTest({
  dataset: 'roll', layer: 'ocr-batching-fix-applied',
  ac: AC, part: null,
  expected: `all ${WRONG_PREFIX}-prefixed AC${AC} rows corrected to ${RIGHT_PREFIX}`,
  actual: {
    corrections: corrections.length, touchedBucketFiles: touchedFiles.size,
    removalsApplied, removalsNotFound, removalsAmbiguous, additionsApplied,
  },
  verdict: removalsNotFound === 0 && removalsAmbiguous === 0 ? 'FIX_APPLIED_CLEAN' : 'FIX_APPLIED_WITH_WARNINGS',
  reason: '144-card manual pixel verification (17 parts, zero exceptions) justified applying the correction to all matching rows, not just the sampled ones',
});
log('\nLogged to test-logs/test-log.jsonl.');
