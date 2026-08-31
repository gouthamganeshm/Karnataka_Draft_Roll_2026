#!/usr/bin/env node
/* Generic version of verify-ac161-fix.mjs — independent byte-for-byte check
 * that fix-confirmed-rows.mjs touched only the intended records.
 *
 *     node scripts/verify-confirmed-rows.mjs cache/confirmed-corrections-10k.json
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { CACHE, ROOT, sha256hex, readJson, log } from './lib/common.mjs';

const DATA = resolve(ROOT, 'docs', 'data');
const correctionsPath = process.argv[2];
if (!correctionsPath) {
  log('Usage: node scripts/verify-confirmed-rows.mjs <corrections.json>');
  process.exit(1);
}
const corrections = JSON.parse(await readFile(correctionsPath, 'utf8'));

const manifest = await readJson(resolve(DATA, 'manifest.json'));
const { shardDepth, suffixLength } = manifest;
const bucketPath = (prefix) => (prefix.length > 2
  ? resolve(DATA, 'roll', prefix.slice(0, 2), `${prefix.slice(2)}.json`)
  : resolve(DATA, 'roll', `${prefix}.json`));
const keyOf = (suffix, ac, part, serial) => `${suffix}|${ac}|${part}|${serial}`;

const expectedRemovals = new Map();
const expectedAdditions = new Map();
for (const c of corrections) {
  const oldHash = sha256hex(c.oldEpic);
  const oldFile = bucketPath(oldHash.slice(0, shardDepth));
  const oldSuffix = oldHash.slice(shardDepth, shardDepth + suffixLength);
  if (!expectedRemovals.has(oldFile)) expectedRemovals.set(oldFile, new Set());
  expectedRemovals.get(oldFile).add(keyOf(oldSuffix, c.ac, c.part, c.serial));

  const newHash = sha256hex(c.newEpic);
  const newFile = bucketPath(newHash.slice(0, shardDepth));
  const newSuffix = newHash.slice(shardDepth, shardDepth + suffixLength);
  if (!expectedAdditions.has(newFile)) expectedAdditions.set(newFile, new Set());
  expectedAdditions.get(newFile).add(keyOf(newSuffix, c.ac, c.part, c.serial));
}
const touchedFiles = new Set([...expectedRemovals.keys(), ...expectedAdditions.keys()]);
log(`${touchedFiles.size} bucket files expected to have changed`);

const tmp = mkdtempSync(join(CACHE, 'generic-fix-verify-'));
log(`Extracting pre-fix docs/data/roll from git HEAD into ${tmp} …`);
execSync(`git archive HEAD -- docs/data/roll | tar -x -C "${tmp.replace(/\\/g, '/')}"`, { cwd: ROOT, stdio: 'inherit', maxBuffer: 1024 * 1024 * 1024 });

let filesChecked = 0;
let removalsOk = 0, removalsBad = 0, removalsMissing = 0;
let additionsOk = 0, additionsBad = 0, additionsMissing = 0;
let untouchedRecordsChecked = 0, unexpectedChanges = 0;
const relFromData = (p) => p.slice(DATA.length + 1).replace(/\\/g, '/');

for (const file of touchedFiles) {
  const rel = relFromData(file);
  const oldPath = join(tmp, 'docs', 'data', rel);
  if (!existsSync(oldPath)) { log(`MISSING pre-fix snapshot for ${rel}`); unexpectedChanges++; continue; }
  const oldRecords = JSON.parse(readFileSync(oldPath, 'utf8'));
  const newRecords = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  filesChecked++;

  const oldByKey = new Map(oldRecords.map((r) => [keyOf(r[0], r[1], r[2], r[3]), r]));
  const newByKey = new Map(newRecords.map((r) => [keyOf(r[0], r[1], r[2], r[3]), r]));
  const expRemove = expectedRemovals.get(file) ?? new Set();
  const expAdd = expectedAdditions.get(file) ?? new Set();

  for (const key of expRemove) {
    const wasThere = oldByKey.has(key);
    const stillThere = newByKey.has(key);
    if (!wasThere) { removalsMissing++; continue; }
    if (stillThere) { removalsBad++; log(`STILL PRESENT after removal: ${key} in ${rel}`); continue; }
    removalsOk++;
  }
  for (const key of expAdd) {
    if (!newByKey.has(key)) { additionsMissing++; log(`MISSING expected addition: ${key} in ${rel}`); continue; }
    additionsOk++;
  }
  for (const [key, oldRec] of oldByKey) {
    if (expRemove.has(key)) continue;
    untouchedRecordsChecked++;
    const newRec = newByKey.get(key);
    if (!newRec || JSON.stringify(newRec) !== JSON.stringify(oldRec)) {
      unexpectedChanges++;
      log(`UNEXPECTED CHANGE: ${key} in ${rel} -- old=${JSON.stringify(oldRec)} new=${JSON.stringify(newRec)}`);
    }
  }
  for (const [key] of newByKey) {
    if (expAdd.has(key)) continue;
    if (!oldByKey.has(key)) {
      unexpectedChanges++;
      log(`UNEXPECTED NEW RECORD: ${key} in ${rel}`);
    }
  }
}

log(`\n=== verification result ===`);
log(`${filesChecked}/${touchedFiles.size} touched files checked`);
log(`Removals: ${removalsOk} confirmed clean, ${removalsBad} BAD, ${removalsMissing} missing`);
log(`Additions: ${additionsOk} confirmed clean, ${additionsMissing} MISSING`);
log(`${untouchedRecordsChecked} untouched records checked byte-for-byte, ${unexpectedChanges} unexpected change(s)`);
log(unexpectedChanges === 0 && removalsBad === 0 && additionsMissing === 0
  ? '\nCLEAN.' : '\nPROBLEMS FOUND.');
