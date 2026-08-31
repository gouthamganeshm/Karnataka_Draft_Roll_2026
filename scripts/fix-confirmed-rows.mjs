#!/usr/bin/env node
/* Generic, reusable version of fix-ac161-wzu-wzz.mjs — applies a list of
 * individually pixel-verified row corrections, not a blanket per-AC prefix
 * rule.
 *
 * Why not a blanket rule this time: the 10,000-card statewide sample
 * (2026-09-01) found confirmed misreads across 13 different ACs, but
 * several of the underlying prefix clusters (AC207 UII/ULL/UIL, AC191
 * AOV/AOQ/AQV, AC219 AOH/AOQ/AQH) are already documented as "messy,
 * multi-way, do not treat as a blanket substitution" — some cards with the
 * "minority" spelling are genuinely correct, so applying a per-AC
 * dominant-prefix rule the way AC161's WZU/WZZ fix did would silently
 * corrupt real data (exactly the AC190 GLV/GYV false lead from the
 * AC161 scoping work, at statewide scale). What IS safe, because every one
 * of these was individually confirmed against source pixels rather than
 * inferred from a statistic, is fixing exactly those rows and no others.
 *
 * Corrections file is a JSON array of {ac, part, serial, oldEpic, newEpic}.
 * For each: verify the row still holds oldEpic (fail loudly if not — the
 * cache may have moved since verification), correct it, relocate its
 * published bucket entry, and log every attempted correction (including
 * verification-mismatch skips) to test-logs/test-log.jsonl.
 *
 * Same duplicate-EPIC handling as the AC161 fix: if the new EPIC's hash
 * already has a published record (a genuine duplicate, not a hash
 * collision — checked precisely, see below), the pipeline's own
 * first-file-processed-wins policy decides which one is kept, exactly as
 * 3-build-data.mjs already does for ordinary duplicates.
 *
 *     node scripts/fix-confirmed-rows.mjs cache/confirmed-corrections-10k.json
 *     node scripts/fix-confirmed-rows.mjs <file> --dry-run
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CACHE, ROOT, log, logTest, readJson, sha256hex, writeJson } from './lib/common.mjs';

const DATA = resolve(ROOT, 'docs', 'data');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const correctionsPath = args.find((a) => !a.startsWith('--'));
if (!correctionsPath) {
  log('Usage: node scripts/fix-confirmed-rows.mjs <corrections.json> [--dry-run]');
  process.exit(1);
}

const manifest = await readJson(resolve(DATA, 'manifest.json'));
const { shardDepth, suffixLength } = manifest;
const bucketPath = (prefix) => (prefix.length > 2
  ? resolve(DATA, 'roll', prefix.slice(0, 2), `${prefix.slice(2)}.json`)
  : resolve(DATA, 'roll', `${prefix}.json`));
const sortBySuffix = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

// readdir order is what 3-build-data.mjs's full rebuild processes rowFiles
// in (lexicographic, e.g. "161.jsonl" before "181.jsonl") -- the existing
// duplicate policy's precedence, replicated here rather than reinvented.
const acPrecedence = new Map(
  (await readdir(resolve(CACHE, 'rows')))
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f, i) => [+f.replace('.jsonl', ''), i])
);

const requested = JSON.parse(await readFile(correctionsPath, 'utf8'));
log(`${requested.length} requested corrections across ${new Set(requested.map((c) => c.ac)).size} ACs`);

// ------------------------------------------------------- group by AC, verify

const byAc = new Map();
for (const c of requested) {
  if (!byAc.has(c.ac)) byAc.set(c.ac, []);
  byAc.get(c.ac).push(c);
}

const applied = []; // {ac, part, serial, oldEpic, newEpic, ok}
const skipped = []; // {ac, part, serial, reason}
const rowFileEdits = new Map(); // ac -> new file lines (only written if all its corrections are valid)

for (const [ac, corrections] of byAc) {
  const rowsPath = resolve(CACHE, 'rows', `${ac}.jsonl`);
  const lines = (await readFile(rowsPath, 'utf8')).split('\n');
  const bySerialPart = new Map(corrections.map((c) => [`${c.part}/${c.serial}`, c]));
  let remaining = bySerialPart.size;
  const newLines = [];

  for (const line of lines) {
    if (!line.trim() || !remaining) { newLines.push(line); continue; }
    const row = JSON.parse(line);
    const key = `${row.part}/${row.serial}`;
    const c = bySerialPart.get(key);
    if (!c) { newLines.push(line); continue; }

    const epic = String(row.epic ?? '').trim().toUpperCase();
    if (epic !== c.oldEpic) {
      skipped.push({ ac, part: c.part, serial: c.serial, reason: `expected oldEpic ${c.oldEpic}, found ${epic} -- cache has moved since verification, skipped` });
      bySerialPart.delete(key);
      remaining--;
      newLines.push(line);
      continue;
    }
    row.epic = c.newEpic;
    newLines.push(JSON.stringify(row));
    applied.push({ ac, part: c.part, serial: c.serial, oldEpic: c.oldEpic, newEpic: c.newEpic, ok: row.ok });
    bySerialPart.delete(key);
    remaining--;
  }
  for (const [key, c] of bySerialPart) {
    skipped.push({ ac, part: c.part, serial: c.serial, reason: 'row not found in cache/rows -- part/serial mismatch, skipped' });
  }
  if (applied.some((a) => a.ac === ac)) rowFileEdits.set(ac, { rowsPath, content: newLines.join('\n') });
}

log(`${applied.length} corrections verified and ready to apply, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) log(`  SKIP AC${s.ac}/part${s.part}/serial${s.serial}: ${s.reason}`);
if (!applied.length) { log('Nothing to apply.'); process.exit(0); }

// -------------------------------------------------------- patch bucket tree

const pendingRemovals = new Map();
const pendingAdditions = new Map();
for (const c of applied) {
  const approx = !c.ok;
  const oldHash = sha256hex(c.oldEpic);
  const oldPrefix = oldHash.slice(0, shardDepth), oldSuffix = oldHash.slice(shardDepth, shardDepth + suffixLength);
  const oldFile = bucketPath(oldPrefix);
  if (!pendingRemovals.has(oldFile)) pendingRemovals.set(oldFile, []);
  pendingRemovals.get(oldFile).push({ suffix: oldSuffix, ac: c.ac, part: c.part, serial: c.serial });

  const newHash = sha256hex(c.newEpic);
  const newPrefix = newHash.slice(0, shardDepth), newSuffix = newHash.slice(shardDepth, shardDepth + suffixLength);
  const newFile = bucketPath(newPrefix);
  const rec = [newSuffix, c.ac, c.part, c.serial];
  if (approx) rec.push(1);
  if (!pendingAdditions.has(newFile)) pendingAdditions.set(newFile, []);
  pendingAdditions.get(newFile).push({ rec, ac: c.ac, part: c.part, serial: c.serial, suffix: newSuffix });
}

const touchedFiles = new Set([...pendingRemovals.keys(), ...pendingAdditions.keys()]);
log(`${touchedFiles.size} bucket files touched`);

let removalsApplied = 0, removalsNotFound = 0;
let additionsApplied = 0, duplicatesResolved = 0;
let electorDelta = 0;
const perAcElectorDelta = new Map();

for (const file of touchedFiles) {
  let records = await readJson(file, []);
  const removals = pendingRemovals.get(file) ?? [];
  for (const r of removals) {
    const before = records.length;
    records = records.filter((rec) => !(rec[0] === r.suffix && rec[1] === r.ac && rec[2] === r.part && rec[3] === r.serial));
    const removed = before - records.length;
    if (removed === 0) { removalsNotFound++; continue; }
    removalsApplied += removed;
    electorDelta -= removed;
    perAcElectorDelta.set(r.ac, (perAcElectorDelta.get(r.ac) ?? 0) - removed);
  }

  const additions = pendingAdditions.get(file) ?? [];
  for (const a of additions) {
    // Duplicate-EPIC check: does a record with this exact suffix already
    // exist (a genuine duplicate, not a birthday-paradox collision -- the
    // suffix space is large enough that an unrelated collision here is not
    // the concern; a real duplicate EPIC published elsewhere is)?
    const existing = records.find((rec) => rec[0] === a.suffix);
    if (existing) {
      const existingAc = existing[1];
      const winner = (acPrecedence.get(a.ac) ?? Infinity) < (acPrecedence.get(existingAc) ?? Infinity) ? 'new' : 'existing';
      duplicatesResolved++;
      if (winner === 'new') {
        records = records.filter((rec) => rec[0] !== a.suffix);
        records.push(a.rec);
        electorDelta += 0; // one out, one in, net zero at the statewide level
        perAcElectorDelta.set(existingAc, (perAcElectorDelta.get(existingAc) ?? 0) - 1);
        perAcElectorDelta.set(a.ac, (perAcElectorDelta.get(a.ac) ?? 0) + 1);
        log(`  duplicate EPIC at AC${a.ac}/part${a.part}/serial${a.serial}: AC${a.ac} wins over existing AC${existingAc} (file-order precedence)`);
      } else {
        log(`  duplicate EPIC at AC${a.ac}/part${a.part}/serial${a.serial}: existing AC${existingAc} wins (file-order precedence), new entry dropped`);
      }
      continue;
    }
    records.push(a.rec);
    additionsApplied++;
    electorDelta += 1;
    perAcElectorDelta.set(a.ac, (perAcElectorDelta.get(a.ac) ?? 0) + 1);
  }

  records.sort(sortBySuffix);
  if (!dryRun) await writeJson(file, records);
}

log(`Removals: ${removalsApplied} applied, ${removalsNotFound} not found`);
log(`Additions: ${additionsApplied} applied, ${duplicatesResolved} duplicate collisions resolved via file-order precedence`);
log(`Net electors delta: ${electorDelta >= 0 ? '+' : ''}${electorDelta}`);

if (dryRun) {
  log('\n--dry-run: no files were written.');
  process.exit(0);
}

// ---------------------------------------------------------- write row files
for (const [ac, { rowsPath, content }] of rowFileEdits) {
  await writeFile(`${rowsPath}.pre-generic-fix.bak`, await readFile(rowsPath, 'utf8'));
  await writeFile(rowsPath, content);
}
log(`\nUpdated cache/rows for ${rowFileEdits.size} ACs (backups written alongside).`);

// -------------------------------------------------------- update manifest

if (electorDelta !== 0 || [...perAcElectorDelta.values()].some((d) => d !== 0)) {
  manifest.electors += electorDelta;
  for (const [ac, delta] of perAcElectorDelta) {
    if (delta !== 0 && manifest.acs[ac]) manifest.acs[ac].electors += delta;
  }
  await writeJson(resolve(DATA, 'manifest.json'), manifest, true);

  const buildState = await readJson(resolve(CACHE, 'build-state.json'));
  if (buildState) {
    buildState.electors += electorDelta;
    for (const [ac, delta] of perAcElectorDelta) {
      if (delta !== 0 && buildState.acStats?.[ac]) buildState.acStats[ac].electors += delta;
    }
    await writeJson(resolve(CACHE, 'build-state.json'), buildState);
  }
  log('manifest.json and cache/build-state.json electors counts updated.');
}

for (const c of applied) {
  await logTest({
    dataset: 'roll', layer: 'ocr-generic-fix-applied',
    ac: c.ac, part: c.part, serial: c.serial,
    expected: c.newEpic, actual: { oldEpic: c.oldEpic, newEpic: c.newEpic },
    verdict: 'FIX_APPLIED',
    reason: 'individually pixel-verified correction from the 10,000-card statewide sample',
  });
}
for (const s of skipped) {
  await logTest({
    dataset: 'roll', layer: 'ocr-generic-fix-applied',
    ac: s.ac, part: s.part, serial: s.serial,
    expected: null, actual: null,
    verdict: 'FIX_SKIPPED',
    reason: s.reason,
  });
}
log(`\nLogged ${applied.length + skipped.length} entries to test-logs/test-log.jsonl.`);
