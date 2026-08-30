#!/usr/bin/env node
/* Stage 13 — the exhaustive, statewide version of the sampled cross-list
 * check `12-full-sweep-asd.mjs`'s B4 section already does. That one hits the
 * live site over HTTP and samples a handful of EPICs per run, deliberately
 * lightweight; this one runs entirely against the local bucket trees and
 * checks every published EPIC in both, once.
 *
 * Both trees share the same shard depth and suffix length (verified, not
 * assumed — see the manifests), so the same SHA-256(EPIC) always lands in
 * the identically-pathed bucket file in both trees. That makes an exhaustive
 * check cheap: read each bucket pair once, merge-compare the two sorted
 * suffix arrays (O(n+m), no cross product), instead of hashing 10.7M EPICs
 * against a lookup structure.
 *
 * A bucket record carries no EPIC (by design — see 3-build-data.mjs's own
 * header comment on why). A suffix match is found first, purely from the
 * published buckets; only then are cache/rows and cache/asd-rows consulted,
 * and only for the handful of colliding suffixes, to recover which EPIC it
 * actually was for reporting.
 *
 *     node scripts/13-overlap-audit.mjs
 */

import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { CACHE, ROOT, log, logTest, progress, readJson, sha256hex } from './lib/common.mjs';

const ROLL_DATA = resolve(ROOT, 'docs', 'data');
const ASD_DATA = resolve(ROOT, 'docs', 'data-asd');

const rollManifest = await readJson(resolve(ROLL_DATA, 'manifest.json'));
const asdManifest = await readJson(resolve(ASD_DATA, 'manifest.json'));
if (rollManifest.shardDepth !== asdManifest.shardDepth || rollManifest.suffixLength !== asdManifest.suffixLength) {
  log('Shard depth / suffix length differ between the two trees — the bucket-pairing '
    + 'shortcut this script relies on does not hold. Aborting rather than silently '
    + 'checking the wrong pairs.');
  process.exit(1);
}

function listBucketFiles(base) {
  const rollDir = resolve(base, 'roll');
  const files = [];
  for (const d1 of readdirSync(rollDir)) {
    const p1 = resolve(rollDir, d1);
    // Depth-4 buckets are nested one level (roll/ab/cd.json); depth<=2 are flat (roll/ab.json).
    if (d1.endsWith('.json')) { files.push(d1); continue; }
    for (const f of readdirSync(p1)) files.push(`${d1}/${f}`);
  }
  return files;
}

log('Listing bucket files in both trees…');
const asdFiles = new Set(listBucketFiles(ASD_DATA));
const rollFiles = new Set(listBucketFiles(ROLL_DATA));
// Only buckets present in BOTH can possibly collide.
const shared = [...asdFiles].filter((f) => rollFiles.has(f));
log(`${asdFiles.size} ASD buckets, ${rollFiles.size} roll buckets, ${shared.length} present in both — checking those.`);

const collisions = []; // [prefix+suffix]
let checked = 0;
let rollEntries = 0;
let asdEntries = 0;

for (const file of shared) {
  const asdRecords = await readJson(resolve(ASD_DATA, 'roll', file), []);
  const rollRecords = await readJson(resolve(ROLL_DATA, 'roll', file), []);
  rollEntries += rollRecords.length;
  asdEntries += asdRecords.length;

  // Both arrays are sorted by suffix (suffix is [0]) — merge-compare.
  let i = 0;
  let j = 0;
  while (i < asdRecords.length && j < rollRecords.length) {
    const a = asdRecords[i][0];
    const b = rollRecords[j][0];
    if (a < b) i++;
    else if (a > b) j++;
    else {
      collisions.push({ suffix: a, asd: asdRecords[i], roll: rollRecords[j] });
      i++; j++;
    }
  }
  if (++checked % 2000 === 0 || checked === shared.length) progress(`  ${checked}/${shared.length} shared buckets checked`);
}
progress('');
log(`Checked ${rollEntries} roll electors against ${asdEntries} ASD rows across ${shared.length} buckets.`);
log(`${collisions.length} suffix collision(s) found.\n`);

if (!collisions.length) {
  log('No EPIC appears on both lists — statewide, exhaustive, not sampled.');
  process.exit(0);
}

// Recover which EPIC each collision actually was, by re-hashing the cached
// rows — the only place the full EPIC still exists once it is bucketed.
log('Recovering the actual EPIC for each collision from cache/rows + cache/asd-rows…');
const bySuffix = new Map(collisions.map((c) => [c.suffix, c]));
let remaining = bySuffix.size;

async function scanForSuffixes(dir, isAsd) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  for (const file of files) {
    if (!remaining) return;
    const rl = createInterface({ input: createReadStream(resolve(dir, file)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!remaining) break;
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const epic = String(row.epic ?? '').trim().toUpperCase();
      const hash = sha256hex(epic);
      const suffix = hash.slice(rollManifest.shardDepth, rollManifest.shardDepth + rollManifest.suffixLength);
      const hit = bySuffix.get(suffix);
      if (hit && !hit[isAsd ? 'asdEpic' : 'rollEpic']) {
        hit[isAsd ? 'asdEpic' : 'rollEpic'] = epic;
        if (hit.asdEpic && hit.rollEpic) remaining--;
      }
    }
  }
}
await scanForSuffixes(resolve(CACHE, 'rows'), false);
await scanForSuffixes(resolve(CACHE, 'asd-rows'), true);

log(`\n=== ${collisions.length} EPIC(s) found on BOTH lists ===`);
for (const c of collisions) {
  const epic = c.rollEpic ?? c.asdEpic ?? '(epic not recovered)';
  log(`  ${epic}  `
    + `roll: AC${c.roll[1]}/part${c.roll[2]}/serial${c.roll[3]}  `
    + `ASD: AC${c.asd[1]}/part${c.asd[2]}/serial${c.asd[3]} reason=${c.asd[4]}`);
  await logTest({
    dataset: 'both', layer: 'overlap-audit', epic,
    ac: c.roll[1], part: c.roll[2],
    expected: null,
    actual: {
      roll: { ac: c.roll[1], part: c.roll[2], serial: c.roll[3] },
      asd: { ac: c.asd[1], part: c.asd[2], serial: c.asd[3], reasonCode: c.asd[4] }
    },
    verdict: 'overlap-found'
  });
}
