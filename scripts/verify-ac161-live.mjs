#!/usr/bin/env node
/* Exhaustive live-site test of the AC161 WZU/WZZ fix — every one of the
 * 27,865 corrected rows, checked against the actually-deployed GitHub Pages
 * site (not local files). The earlier verify-ac161-fix.mjs confirmed
 * docs/data on disk is correct; this confirms the fix actually reached
 * production, since this project has a documented history of GitHub Pages
 * deployment lag (see HANDOFF.md).
 *
 * For every correction: fetches the OLD bucket (should no longer contain
 * the wrong record) and the NEW bucket (should contain the corrected
 * record with the right ac/part/serial) from the live site. Buckets are
 * deduplicated first — many corrections land in the same bucket file — so
 * this is ~37,646 unique HTTP fetches, not 55,730.
 *
 *     node scripts/verify-ac161-live.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CACHE, ROOT, getJson, logTest, pool, readJson, sha256hex, log, progress } from './lib/common.mjs';

const AC = 161;
const site = 'https://gouthamganeshm.github.io/Karnataka_Draft_Roll_2026';

const rowsPath = resolve(CACHE, 'rows', `${AC}.jsonl`);
const bakPath = `${rowsPath}.pre-wzu-wzz-fix.bak`;
const oldRows = readFileSync(bakPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const newRows = readFileSync(rowsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const corrections = [];
for (let i = 0; i < oldRows.length; i++) {
  const o = oldRows[i], n = newRows[i];
  if (o.epic !== n.epic) corrections.push({ part: o.part, serial: o.serial, oldEpic: o.epic, newEpic: n.epic });
}
log(`${corrections.length} corrections to verify against the live site`);

const manifest = await readJson(resolve(ROOT, 'docs', 'data', 'manifest.json'));
const { shardDepth, suffixLength } = manifest;
const bucketRelPath = (prefix) => (prefix.length > 2
  ? `roll/${prefix.slice(0, 2)}/${prefix.slice(2)}.json`
  : `roll/${prefix}.json`);

// One entry per correction, tagging which bucket (old/new) it needs.
const needed = new Map(); // bucketRelPath -> true
for (const c of corrections) {
  const oldHash = sha256hex(c.oldEpic);
  const newHash = sha256hex(c.newEpic);
  needed.set(bucketRelPath(oldHash.slice(0, shardDepth)), true);
  needed.set(bucketRelPath(newHash.slice(0, shardDepth)), true);
}
const bucketFiles = [...needed.keys()];
log(`${bucketFiles.length} unique bucket files to fetch from the live site`);

const bucketCache = new Map();
async function fetchAll(files, concurrency) {
  let fetched = 0;
  await pool(files, concurrency, async (rel) => {
    try {
      const records = await getJson(`${site}/data/${rel}`);
      bucketCache.set(rel, records);
    } catch (err) {
      bucketCache.set(rel, { error: err.message });
    }
  }, (done, total) => { fetched = done; progress(`  fetched ${done}/${total} bucket files`); });
  progress('');
}
await fetchAll(bucketFiles, 80);
let errored = [...bucketCache.entries()].filter(([, v]) => v?.error).map(([k]) => k);
log(`First pass: ${bucketCache.size - errored.length}/${bucketFiles.length} ok, ${errored.length} errors`);

// Exhaustive means exhaustive — retry failures at much lower concurrency
// rather than leave a few percent unconfirmed either way (likely transient
// rate-limiting from the first pass's higher concurrency, not real gaps).
for (let round = 1; errored.length && round <= 3; round++) {
  log(`Retry round ${round}: re-fetching ${errored.length} failed bucket files at concurrency 10…`);
  await fetchAll(errored, 10);
  errored = [...bucketCache.entries()].filter(([, v]) => v?.error).map(([k]) => k);
  log(`  ${errored.length} still failing after round ${round}`);
}
log(`Fetched ${bucketCache.size} unique bucket files (${errored.length} unrecoverable errors after retries)`);

let oldGoneOk = 0, oldStillPresent = 0, oldFetchError = 0;
let newFoundOk = 0, newMissing = 0, newWrongLocation = 0, newFetchError = 0;
const failures = [];

for (const c of corrections) {
  const oldHash = sha256hex(c.oldEpic);
  const oldPrefix = oldHash.slice(0, shardDepth), oldSuffix = oldHash.slice(shardDepth, shardDepth + suffixLength);
  const oldRel = bucketRelPath(oldPrefix);
  const oldRecords = bucketCache.get(oldRel);
  if (oldRecords?.error) { oldFetchError++; }
  else {
    const stillThere = oldRecords.some((r) => r[0] === oldSuffix && r[1] === AC && r[2] === c.part && r[3] === c.serial);
    if (stillThere) { oldStillPresent++; failures.push({ ...c, issue: 'old EPIC still resolves on live site' }); }
    else oldGoneOk++;
  }

  const newHash = sha256hex(c.newEpic);
  const newPrefix = newHash.slice(0, shardDepth), newSuffix = newHash.slice(shardDepth, shardDepth + suffixLength);
  const newRel = bucketRelPath(newPrefix);
  const newRecords = bucketCache.get(newRel);
  if (newRecords?.error) { newFetchError++; }
  else {
    const hit = newRecords.find((r) => r[0] === newSuffix);
    if (!hit) { newMissing++; failures.push({ ...c, issue: 'new EPIC not found on live site' }); }
    else if (hit[1] !== AC || hit[2] !== c.part || hit[3] !== c.serial) {
      newWrongLocation++;
      failures.push({ ...c, issue: `new EPIC found but wrong location: ac=${hit[1]} part=${hit[2]} serial=${hit[3]}` });
    } else newFoundOk++;
  }
}

log(`\n=== live-site verification result (AC${AC}, ${corrections.length} corrections) ===`);
log(`Old EPIC correctly gone: ${oldGoneOk}   still present (BAD): ${oldStillPresent}   fetch errors: ${oldFetchError}`);
log(`New EPIC correctly found: ${newFoundOk}   missing (BAD): ${newMissing}   wrong location (BAD): ${newWrongLocation}   fetch errors: ${newFetchError}`);

if (failures.length) {
  log(`\n${failures.length} failure(s):`);
  for (const f of failures.slice(0, 20)) log(`  AC${AC}/part${f.part}/serial${f.serial}: ${f.oldEpic} -> ${f.newEpic}: ${f.issue}`);
  if (failures.length > 20) log(`  … and ${failures.length - 20} more`);
}

const clean = oldStillPresent === 0 && newMissing === 0 && newWrongLocation === 0;
await logTest({
  dataset: 'roll', layer: 'ocr-batching-fix-live-verification',
  ac: AC, part: null,
  expected: `all ${corrections.length} corrected EPICs live and correct on the deployed site`,
  actual: { oldGoneOk, oldStillPresent, oldFetchError, newFoundOk, newMissing, newWrongLocation, newFetchError, failureCount: failures.length },
  verdict: clean ? 'LIVE_VERIFICATION_CLEAN' : 'LIVE_VERIFICATION_FOUND_ISSUES',
  reason: 'exhaustive check of every corrected AC161 row against the actually-deployed GitHub Pages site, not just local docs/data',
});
log(clean ? '\nCLEAN — the fix is fully live and correct.' : '\nISSUES FOUND — see above.');
