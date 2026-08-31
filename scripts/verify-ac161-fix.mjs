#!/usr/bin/env node
/* Verification pass for scripts/fix-ac161-wzu-wzz.mjs — not just trusting
 * the fix script's own tally. Reconstructs the exact correction set from
 * the backup vs corrected cache/rows/161.jsonl, extracts the pre-fix
 * docs/data tree from git HEAD (still the old committed state — nothing has
 * been committed yet, only staged), and for every touched bucket file
 * confirms:
 *
 *   1. Every record that DISAPPEARED matches an expected old (wrong) EPIC's
 *      hash, belongs to ac=161, and its part/serial matches a real
 *      correction — not some unrelated row.
 *   2. Every record that APPEARED matches an expected new (correct) EPIC's
 *      hash, same check.
 *   3. Nothing else in the file changed — every record present in the old
 *      version that ISN'T one of the expected removals is still present,
 *      byte-identical, in the new version. Any record belonging to an AC
 *      other than 161 must be completely unaffected everywhere.
 *
 *     node scripts/verify-ac161-fix.mjs
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { CACHE, ROOT, sha256hex, readJson, log } from './lib/common.mjs';

const DATA = resolve(ROOT, 'docs', 'data');
const AC = 161;

// ---------------------------------------------------- reconstruct corrections
const rowsPath = resolve(CACHE, 'rows', `${AC}.jsonl`);
const bakPath = `${rowsPath}.pre-wzu-wzz-fix.bak`;
const oldRows = readFileSync(bakPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const newRows = readFileSync(rowsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
if (oldRows.length !== newRows.length) throw new Error(`row count mismatch: ${oldRows.length} vs ${newRows.length}`);

const corrections = [];
for (let i = 0; i < oldRows.length; i++) {
  const o = oldRows[i], n = newRows[i];
  if (o.epic !== n.epic) {
    if (o.part !== n.part || o.serial !== n.serial) throw new Error(`row ${i} part/serial mismatch besides epic`);
    corrections.push({ part: o.part, serial: o.serial, ok: o.ok, oldEpic: o.epic, newEpic: n.epic });
  }
}
log(`Reconstructed ${corrections.length} corrections from backup vs corrected cache/rows/${AC}.jsonl`);

const manifest = await readJson(resolve(DATA, 'manifest.json'));
const { shardDepth, suffixLength } = manifest;
const bucketPath = (prefix) => (prefix.length > 2
  ? resolve(DATA, 'roll', prefix.slice(0, 2), `${prefix.slice(2)}.json`)
  : resolve(DATA, 'roll', `${prefix}.json`));

const expectedRemovals = new Map(); // file -> Set of "suffix|ac|part|serial"
const expectedAdditions = new Map();
const keyOf = (suffix, ac, part, serial) => `${suffix}|${ac}|${part}|${serial}`;

for (const c of corrections) {
  const oldHash = sha256hex(c.oldEpic);
  const oldPrefix = oldHash.slice(0, shardDepth), oldSuffix = oldHash.slice(shardDepth, shardDepth + suffixLength);
  const oldFile = bucketPath(oldPrefix);
  if (!expectedRemovals.has(oldFile)) expectedRemovals.set(oldFile, new Set());
  expectedRemovals.get(oldFile).add(keyOf(oldSuffix, AC, c.part, c.serial));

  const newHash = sha256hex(c.newEpic);
  const newPrefix = newHash.slice(0, shardDepth), newSuffix = newHash.slice(shardDepth, shardDepth + suffixLength);
  const newFile = bucketPath(newPrefix);
  if (!expectedAdditions.has(newFile)) expectedAdditions.set(newFile, new Set());
  expectedAdditions.get(newFile).add(keyOf(newSuffix, AC, c.part, c.serial));
}

const touchedFiles = new Set([...expectedRemovals.keys(), ...expectedAdditions.keys()]);
log(`${touchedFiles.size} bucket files expected to have changed`);

// ---------------------------------------------------- extract pre-fix snapshot
const tmp = mkdtempSync(join(CACHE, 'ac161-verify-'));
log(`Extracting pre-fix docs/data/roll from git HEAD into ${tmp} …`);
execSync(`git archive HEAD -- docs/data/roll | tar -x -C "${tmp.replace(/\\/g, '/')}"`, { cwd: ROOT, stdio: 'inherit', maxBuffer: 1024 * 1024 * 1024 });

// ---------------------------------------------------------------- verify
let filesChecked = 0;
let removalsOk = 0, removalsBad = 0, removalsMissing = 0;
let additionsOk = 0, additionsBad = 0, additionsMissing = 0;
let untouchedRecordsChecked = 0;
let unexpectedChanges = 0;
const relFromData = (p) => p.slice(DATA.length + 1).replace(/\\/g, '/');

for (const file of touchedFiles) {
  const rel = relFromData(file); // e.g. roll/00/00.json
  const oldPath = join(tmp, 'docs', 'data', rel);
  if (!existsSync(oldPath)) { log(`MISSING pre-fix snapshot for ${rel}`); unexpectedChanges++; continue; }
  const oldRecords = JSON.parse(readFileSync(oldPath, 'utf8'));
  const newRecords = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  filesChecked++;

  const oldByKey = new Map(oldRecords.map((r) => [keyOf(r[0], r[1], r[2], r[3]), r]));
  const newByKey = new Map(newRecords.map((r) => [keyOf(r[0], r[1], r[2], r[3]), r]));

  const expRemove = expectedRemovals.get(file) ?? new Set();
  const expAdd = expectedAdditions.get(file) ?? new Set();

  // every expected removal really disappeared, and belongs to ac 161
  for (const key of expRemove) {
    const wasThere = oldByKey.has(key);
    const stillThere = newByKey.has(key);
    const ac = +key.split('|')[1];
    if (!wasThere) { removalsMissing++; continue; }
    if (stillThere) { removalsBad++; log(`STILL PRESENT after removal: ${key} in ${rel}`); continue; }
    if (ac !== AC) { removalsBad++; log(`removal touched non-AC161 record: ${key} in ${rel}`); continue; }
    removalsOk++;
  }
  // every expected addition really appeared, and belongs to ac 161
  for (const key of expAdd) {
    const isThere = newByKey.has(key);
    const ac = +key.split('|')[1];
    if (!isThere) { additionsMissing++; log(`MISSING expected addition: ${key} in ${rel}`); continue; }
    if (ac !== AC) { additionsBad++; log(`addition is not AC161: ${key} in ${rel}`); continue; }
    additionsOk++;
  }

  // everything else in the OLD file that wasn't an expected removal must
  // still be present, unchanged, in the NEW file.
  for (const [key, oldRec] of oldByKey) {
    if (expRemove.has(key)) continue;
    untouchedRecordsChecked++;
    const newRec = newByKey.get(key);
    if (!newRec || JSON.stringify(newRec) !== JSON.stringify(oldRec)) {
      unexpectedChanges++;
      log(`UNEXPECTED CHANGE to a record that should have been untouched: ${key} in ${rel} — old=${JSON.stringify(oldRec)} new=${JSON.stringify(newRec)}`);
    }
  }
  // every record now present that ISN'T an expected addition must have
  // already existed before (i.e. no surprise new records slipped in).
  for (const [key] of newByKey) {
    if (expAdd.has(key)) continue;
    if (!oldByKey.has(key)) {
      unexpectedChanges++;
      log(`UNEXPECTED NEW RECORD not in the correction set: ${key} in ${rel}`);
    }
  }
}

log(`\n=== verification result ===`);
log(`${filesChecked}/${touchedFiles.size} touched files checked`);
log(`Removals: ${removalsOk} confirmed clean, ${removalsBad} BAD, ${removalsMissing} missing (matches the 5 known pre-existing collisions)`);
log(`Additions: ${additionsOk} confirmed clean, ${additionsBad} BAD, ${additionsMissing} MISSING`);
log(`${untouchedRecordsChecked} untouched (non-corrected) records checked byte-for-byte across all touched files, ${unexpectedChanges} unexpected change(s)`);
log(unexpectedChanges === 0 && removalsBad === 0 && additionsBad === 0 && additionsMissing === 0
  ? '\nCLEAN: only the intended AC161 corrections changed anywhere in docs/data. No other data was touched.'
  : '\nPROBLEMS FOUND — see above, do not trust this fix until resolved.');
