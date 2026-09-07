/* Stage 19 — notices rows to bucket files.
 *
 * Third dataset, sibling of `3-build-data.mjs` (roll) and
 * `10-build-asd-data.mjs` (ASD) — same isolation rule as both of those state
 * explicitly, for the same reason: writes only to
 *
 *   docs/data-notices/manifest.json
 *   docs/data-notices/roll/<ab>/<cd>.json   same hash-bucket layout as the
 *                                           other two, so app.js's binary
 *                                           search works unchanged against it
 *
 * `docs/data-notices` is a *sibling* of `docs/data`, deliberately not a
 * child of it — see `10-build-asd-data.mjs`'s ASD_DATA constant for why that
 * placement is load-bearing (the roll's full-rebuild `rm()` must never be
 * able to reach this tree).
 *
 * Coverage here is NOT the same guarantee as the roll's or ASD's. Those two
 * read every (ac, part) in the manifest, so "not found" is a hard, complete
 * answer once coverage reads 100%. This dataset's source is 34
 * independently-uploaded Drive trees (see HANDOFF.md's notices section) —
 * `18-extract-notices.py` only ever confirms "a notice exists here" or
 * "this specific file could not be read"; it cannot confirm "no notice
 * exists for this booth" the way a 404 does for ASD, because a booth with
 * zero rows in a resolved report is indistinguishable, from this script's
 * point of view, from a booth whose report was never found at all. The
 * manifest therefore reports `partsWithData` (booths this dataset actually
 * has at least one row for) rather than claiming a coverage percentage
 * against the roll's full part count — do not add one without first closing
 * that gap in the extraction script (see its own header comment).
 *
 *     node scripts/19-build-notices-data.mjs
 */

import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { CACHE, ROOT, fmtBytes, log, progress, readJson, sha256hex, writeJson } from './lib/common.mjs';

/* Merge build, not a blind full rebuild — this is the fix for a real,
 * repeated failure this project's own Actions runs hit: a single flaky
 * district (Bangalore Rural, Hassan, Chitradurga, at various points) would
 * make guard-notices-coverage.mjs correctly refuse to publish ANYTHING,
 * even though the other 25+ districts in the same run genuinely improved
 * (a bug fix, a new field, a district that finally cleared Drive's
 * throttling) — three runs in a row lost real progress to one unrelated
 * failure. Modelled on karnataka-asddo-dashboard's own merge-build step
 * (3b-merge-build.mjs): rebuild fresh only for ACs this run actually
 * produced rows for, and carry every other AC's already-published records
 * forward unchanged, read straight out of the currently-checked-out
 * docs/data-notices rather than re-deriving them.
 *
 * Only safe when the shard depth does not change between builds — a bucket
 * record stores a hash *suffix*, not the EPIC itself (same privacy
 * reasoning as the roll/ASD datasets' own bucket format: a leaked bucket
 * exposes far less than a full EPIC list), so a carried-over record cannot
 * be rehashed into a different-depth prefix. At the current ~4M-row scale
 * this needs a roughly 16x change in row count to ever trip (see the
 * shardDepth formula below), so treated as the expected common case, with
 * a loud, explicit fallback — not a crash — if it ever does not hold. */
async function loadOldBuckets(oldManifest) {
  const byPrefix = new Map(); // prefix -> records[]
  const acPartsWithData = new Map(); // acNo -> Set(partNo)
  let files;
  try {
    files = await readdir(resolve(NOTICES_DATA, 'roll'), { recursive: true });
  } catch {
    return { byPrefix, acPartsWithData };
  }
  for (const rel of files.filter((f) => f.endsWith('.json'))) {
    const prefix = rel.replace(/\.json$/, '').replace(/[\\/]/g, '');
    const records = await readJson(resolve(NOTICES_DATA, 'roll', rel));
    if (!records) continue;
    byPrefix.set(prefix, records);
    for (const rec of records) {
      const [, acNo, partNo] = rec;
      if (!acPartsWithData.has(acNo)) acPartsWithData.set(acNo, new Set());
      acPartsWithData.get(acNo).add(partNo);
    }
  }
  void oldManifest;
  return { byPrefix, acPartsWithData };
}

const NOTICES_ROWS = resolve(CACHE, 'notices-rows');
const NOTICES_DATA = resolve(ROOT, 'docs', 'data-notices');

const TARGET_PER_BUCKET = 600;
const SUFFIX = 8;
const EPIC_RE = /^[A-Z]{3}[0-9]{7,8}$/;

const bucketPath = (prefix) => (prefix.length > 2
  ? resolve(NOTICES_DATA, 'roll', prefix.slice(0, 2), `${prefix.slice(2)}.json`)
  : resolve(NOTICES_DATA, 'roll', `${prefix}.json`));

const sortBySuffix = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

// A committed static seed (seed/ac-metadata.json), not cache/manifest.json.
// This script only ever needs each AC's name/nameKn/district and its total
// part count — static facts that do not change run to run — never the
// per-part detail the roll's own manifest carries. cache/manifest.json is
// gitignored and simply does not exist on a fresh GitHub Actions runner,
// which is exactly where this script needs to run (see the notices-import
// workflow's build job); re-running the roll's own 1-discover.mjs there to
// get it would hit ECI's CDN with ~2,700 HEAD requests per build for data
// that never changes, and risks the exact "runner kept returning 406" block
// documented in HANDOFF.md section 4b for a completely unrelated pipeline.
const manifestIn = await readJson(resolve(ROOT, 'seed', 'ac-metadata.json'));
if (!manifestIn) {
  log('seed/ac-metadata.json missing. Regenerate it from cache/manifest.json (see HANDOFF.md).');
  process.exit(1);
}

let rowFiles;
try {
  rowFiles = (await readdir(NOTICES_ROWS)).filter((f) => f.endsWith('.jsonl'));
} catch {
  log(`No rows in ${NOTICES_ROWS}. Run \`python scripts/18-extract-notices.py\` first.`);
  process.exit(1);
}
if (!rowFiles.length) {
  log('Nothing to build.');
  process.exit(1);
}
const freshAcs = new Set(rowFiles.map((f) => +f.replace('.jsonl', '')));

const oldManifest = await readJson(resolve(NOTICES_DATA, 'manifest.json'));
const { byPrefix: oldByPrefix, acPartsWithData: oldAcParts } = await loadOldBuckets(oldManifest);
// Only the ACs this run did NOT touch get carried forward — an AC present
// in both is fresh data entirely replacing its old records, never a mix.
const preservedAcs = [...oldAcParts.keys()].filter((ac) => !freshAcs.has(ac));
const preservedRowCount = preservedAcs.reduce((n, ac) => {
  let c = 0;
  for (const records of oldByPrefix.values()) for (const r of records) if (r[1] === ac) c++;
  return n + c;
}, 0);

log(`Counting notices rows across ${rowFiles.length} constituencies…`);
let total = 0;
for (const file of rowFiles) {
  let n = 0;
  const rl = createInterface({ input: createReadStream(resolve(NOTICES_ROWS, file)), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) n++;
  total += n;
  progress(`  ${file}: ${total} so far`);
}
progress('');
log(`${total} fresh notices rows, ${preservedRowCount} preserved from ${preservedAcs.length} untouched AC(s)`);
total += preservedRowCount;

const shardDepth = Math.min(4, Math.max(1,
  Math.round(Math.log(Math.max(total, 1) / TARGET_PER_BUCKET) / Math.log(16))
));
// Merge is only valid if the depth this run computes matches the depth the
// preserved records were already sharded under — see this file's header
// comment for why a mismatch can't be rehashed from a bucket record alone.
const canMerge = !oldManifest || shardDepth === oldManifest.shardDepth;
if (!canMerge && preservedAcs.length) {
  log(`::warning::shard depth would change (${oldManifest.shardDepth} -> ${shardDepth}) — ` +
      `cannot merge ${preservedAcs.length} preserved AC(s) into a different-depth rebuild. ` +
      `Falling back to a fresh-only build; guard-notices-coverage.mjs will correctly block ` +
      `publishing if this run's own coverage is not a superset of what is already live.`);
}
log(`Bucket depth ${shardDepth} (${16 ** shardDepth} buckets, ~${Math.round(total / 16 ** shardDepth)} each)`);

const buckets = new Map();
const bucketSuffixes = new Map();
const acStats = {};
let electors = 0;
let duplicates = 0;
let malformed = 0;
let built = 0;

await rm(NOTICES_DATA, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 });
await mkdir(resolve(NOTICES_DATA, 'roll'), { recursive: true });

for (const file of rowFiles) {
  const acNo = +file.replace('.jsonl', '');
  const partsWithData = new Set();

  const rl = createInterface({ input: createReadStream(resolve(NOTICES_ROWS, file)), crlfDelay: Infinity });
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
    // [suffix, ac, part, serial, reason, age, gender, name, fileId]
    // fileId is the Google Drive file this row was read from — lets the UI
    // link straight to the source PDF, same idea as the roll/ASD datasets'
    // own deterministic-URL source links, just carried as data instead of
    // built from a formula (Drive has no predictable per-file URL scheme).
    buckets.get(prefix).push([
      suffix, acNo, partNo, +row.serial || 0, row.reason || '',
      row.age ?? null, row.gender || '', row.name || '', row.fileId || ''
    ]);

    partsWithData.add(partNo);
    if (++built % 100000 === 0) progress(`  ${built}/${total}`);
  }

  acStats[acNo] = { rows: [...partsWithData].length ? electors : 0, partsWithData: partsWithData.size };
}
progress('');

// Carry forward every preserved AC's already-published records verbatim —
// they were already deduped and validated in whichever earlier run produced
// them, so no suffix-collision or EPIC_RE re-check here, unlike fresh rows
// above. Skipped entirely (falls through to the fresh-only build) if the
// shard depth changed — see `canMerge` above.
let preserved = 0;
if (canMerge) {
  for (const ac of preservedAcs) {
    const parts = oldAcParts.get(ac) ?? new Set();
    acStats[ac] = { rows: 0, partsWithData: parts.size };
  }
  for (const [prefix, records] of oldByPrefix) {
    const keep = records.filter((r) => preservedAcs.includes(r[1]));
    if (!keep.length) continue;
    if (!buckets.has(prefix)) buckets.set(prefix, []);
    buckets.get(prefix).push(...keep);
    preserved += keep.length;
  }
  if (preserved) log(`Carried forward ${preserved} rows across ${preservedAcs.length} untouched AC(s)`);
}
electors += preserved;

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
let acCount = 0;
for (const ac of manifestIn.constituencies) {
  const stat = acStats[ac.acNumber];
  if (!stat) continue;
  acCount++;
  acs[ac.acNumber] = {
    name: ac.name, nameKn: ac.nameKn, district: ac.district,
    parts: ac.parts, partsWithData: stat.partsWithData
  };
}

await writeJson(resolve(NOTICES_DATA, 'manifest.json'), {
  state: manifestIn.state,
  builtAt: new Date().toISOString(),
  shardDepth,
  suffixLength: SUFFIX,
  rows: electors,
  constituencies: acCount,
  // Deliberately no `coverage` field — see this file's header comment for
  // why one would overclaim what this dataset can actually promise.
  acs
}, true);

log(`\nWrote ${buckets.size} notices buckets (${fmtBytes(bytes)}) to ${NOTICES_DATA}`);
log(`  ${electors} notices rows, ${acCount} constituencies represented`);
if (duplicates) log(`  ${duplicates} duplicate EPICs skipped`);
if (malformed) log(`  ${malformed} rows withheld (malformed EPIC or unparsed row)`);
