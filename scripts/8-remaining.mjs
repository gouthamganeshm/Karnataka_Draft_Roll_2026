#!/usr/bin/env node
/* Stage 8 — what's left to read.
 *
 * `2-extract.py` is already resumable on its own (it skips anything recorded
 * in `cache/done/<ac>.txt`), so this script changes nothing about how
 * extraction runs. It exists for the point where the statewide pass winds
 * down and what's left is a long tail of individual booths scattered across
 * many ACs rather than whole constituencies — at that point "just run the
 * extractor again" burns time re-scanning tens of thousands of already-done
 * parts to find the handful that are not. This writes down exactly which
 * booths those are, so the final pass can be `--ac`-targeted instead.
 *
 *     node scripts/8-remaining.mjs
 *
 * Reads `cache/manifest.json` (full job list) against every `cache/done/*.txt`
 * ledger and writes `cache/remaining-parts.json`. Safe to run at any time,
 * including while extraction is live — a part finishing between the read and
 * the write just means the note is one part more conservative than reality,
 * never less.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CACHE, log, readJson, writeJson } from './lib/common.mjs';

const manifest = await readJson(resolve(CACHE, 'manifest.json'));
if (!manifest) {
  log('No cache/manifest.json — run stage 1 first.');
  process.exit(1);
}

const DONE = resolve(CACHE, 'done');
const doneFiles = await readdir(DONE).catch(() => []);

// `cache/done/<ac>.txt` is written with `\n` by Python but has been read back
// with a bare `.split('\n')` more than once and quietly miscounted on this
// Windows checkout, where the OS/editor path in between can leave `\r\n` —
// `\r` stays glued to the last digit and never matches a bare part number.
// Splitting on any run of whitespace sidesteps the line-ending question
// entirely rather than trying to guess which ending is in play.
async function readDoneSet(acNo) {
  const text = await readFile(resolve(DONE, `${acNo}.txt`), 'utf8').catch(() => '');
  return new Set(text.split(/\s+/).filter(Boolean));
}

const byAc = {};
let totalRemaining = 0;
let totalParts = 0;

for (const ac of manifest.constituencies) {
  const done = await readDoneSet(ac.acNumber);
  const remaining = ac.parts
    .map((p) => p.partNumber)
    .filter((n) => !done.has(String(n)))
    .sort((a, b) => a - b);
  totalParts += ac.parts.length;
  totalRemaining += remaining.length;
  if (remaining.length > 0) {
    byAc[ac.acNumber] = { name: ac.name, total: ac.parts.length, remaining };
  }
}

await writeJson(resolve(CACHE, 'remaining-parts.json'), {
  generatedAt: new Date().toISOString(),
  totalParts,
  totalRemaining,
  acsIncomplete: Object.keys(byAc).length,
  byAc
}, true);

log(`${totalRemaining}/${totalParts} parts remaining across ${Object.keys(byAc).length} ACs.\n`);

const rows = Object.entries(byAc)
  .map(([acNo, v]) => ({ acNo: Number(acNo), ...v }))
  .sort((a, b) => b.remaining.length - a.remaining.length);

for (const r of rows) {
  log(`  AC${r.acNo} ${r.name}: ${r.remaining.length}/${r.total} left`);
}

if (rows.length > 0) {
  // `--ac` takes exactly one constituency per run — no multi-value form —
  // so finishing the tail is one invocation per AC, not one combined command.
  log('\nTo finish just these, once the statewide pass is done:');
  for (const r of rows) log(`  python scripts/2-extract.py --ac ${r.acNo}`);
}

log(`\nWrote cache/remaining-parts.json — full per-booth part-number lists live there.`);
