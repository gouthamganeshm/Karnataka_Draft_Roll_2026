/* Stage 1 — what exists.
 *
 * Builds the district -> assembly constituency -> polling part tree that every
 * later stage walks, into `cache/manifest.json`.
 *
 * Districts and constituencies come from the ECI gateway: `/common/districts/S10`
 * and `/common/acs/<districtCd>` are open GETs and give both English and Kannada
 * names.
 *
 * Polling parts do NOT come from an API. `get-publish-part-list` encrypts its
 * request body, and the CEO's `ac_names.csv` — which this stage used to fall
 * back to — is stale: it lists 43,398 parts statewide where the SIR draft has
 * 60,923, and 226 parts for AC 196 where the draft has 282. Part 227 of AC 196
 * is absent from it entirely, despite being a real published booth.
 *
 * So parts are discovered from the published PDFs themselves. Every part is
 * served at a deterministic public path on ECI's CDN, and parts run contiguously
 * from 1..N (verified by enumerating all 282 of AC 196: no holes, nothing past
 * the end). That makes N recoverable with a doubling probe and a binary search —
 * about a dozen HEAD requests per constituency instead of one guessed payload.
 *
 * Booth NAMES are deliberately not carried over from `ac_names.csv`. The draft
 * renumbered parts, so a name from the old cascade can land on a different booth
 * than the one it describes — and a wrong booth address sends a voter to the
 * wrong ERO counter. Parts therefore carry a number and no name until a name can
 * be read from the roll itself.
 *
 *   node scripts/1-discover.mjs
 *   node scripts/1-discover.mjs --district S1002
 *   node scripts/1-discover.mjs --roll-type S10-2026-SIR-DR
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CACHE, getJson, log, pool, progress, readJson, writeJson
} from './lib/common.mjs';

const GATEWAY = 'https://gateway-voters.eci.gov.in/api/v1';
const STATE = 'S10';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const onlyDistrict = argValue('--district');
const concurrency = Number(argValue('--concurrency') ?? 4);

// The publication being indexed. The portal lists this as "SIR DraftRoll - 2026"
// under the option value S10-2026-DR; it is recorded in the manifest so a later
// revision cannot be mistaken for this one.
const rollTypeArg = argValue('--roll-type') ?? 'S10-2026-DR';

/* Where a published part PDF lives. Kannada only: both KAN and ENG are
 * published for every AC, OCR reads only the serial and the EPIC (ASCII in
 * either), so the language is a canonical-source choice, not an accuracy one. */
const CDN = 'https://voters.eci.gov.in/eroll/2026/s10/sir-draftroll';
const partUrl = (ac, part) =>
  `${CDN}/${ac}/2026-EROLLGEN-S10-${ac}-SIR-DraftRoll-Revision1-KAN-${part}-WI.pdf`;

/* Does this part exist? A missing part is a clean 404; anything else is treated
 * as unknown and retried, so a flaky response never shortens a constituency. */
async function partExists(ac, part, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(partUrl(ac, part), { method: 'HEAD', redirect: 'follow' });
      if (res.status === 404) return false;
      if (res.ok) return true;
    } catch {
      // network error — fall through to the retry
    }
    if (attempt < tries) await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
  }
  throw new Error(`could not determine whether AC ${ac} part ${part} exists`);
}

await mkdir(CACHE, { recursive: true });

// ------------------------------------------------------------ districts + ACs

log('Listing districts…');
const districts = (await getJson(`${GATEWAY}/common/districts/${STATE}`))
  .filter((d) => !onlyDistrict || d.districtCd === onlyDistrict)
  .map((d) => ({
    districtCd: d.districtCd,
    districtNo: +d.districtNo,
    name: d.districtValue.trim(),
    nameKn: (d.districtValueHindi ?? '').trim()
  }))
  .sort((a, b) => a.districtNo - b.districtNo);
log(`  ${districts.length} districts`);

log('Listing assembly constituencies…');
const acs = [];
await pool(districts, concurrency, async (d) => {
  const list = await getJson(`${GATEWAY}/common/acs/${d.districtCd}`);
  for (const a of list) {
    acs.push({
      acNumber: +a.asmblyNo,
      name: (a.asmblyName ?? '').trim(),
      nameKn: (a.asmblyNameL1 ?? '').trim(),
      category: (a.category ?? '').trim(),
      districtCd: d.districtCd,
      district: d.name
    });
  }
}, (done, total) => progress(`  ${done}/${total} districts, ${acs.length} ACs`));
progress('');
acs.sort((a, b) => a.acNumber - b.acNumber);
log(`  ${acs.length} constituencies`);

if (!acs.length) {
  log('\nNo constituencies returned. The gateway is reachable but answered empty —');
  log('refusing to write a manifest that would silently narrow every later stage.');
  process.exit(1);
}

// ------------------------------------------------------------ the publication

/* Which publication to index. `--roll-type` wins; otherwise reuse whatever the
 * last successful run found, so a re-run during an import does not drift onto a
 * different revision halfway through. */
const previous = await readJson(resolve(CACHE, 'manifest.json'));
const rollType = rollTypeArg ?? previous?.rollType ?? null;
if (rollType) log(`\nPublication: ${rollType}`);
else log('\nNo --roll-type given and none cached; will accept whatever the portal lists.');

// ------------------------------------------------------------ parts

/* How many parts does this constituency have?
 *
 * Parts are contiguous 1..N, so N is the boundary between the last 200 and the
 * first 404. Double until a 404 is seen, then bisect. That is ~log2(N) requests
 * — a dozen or so — against the ~600 a linear walk would cost on the largest AC.
 *
 * The doubling cap is a guard, not a real limit: the largest constituency in the
 * state is 605 parts, so a probe still answering 200 at 4096 means the CDN has
 * stopped returning honest 404s and the count cannot be trusted. */
async function countParts(ac) {
  if (!(await partExists(ac, 1))) return 0;

  let lo = 1;
  let hi = 2;
  while (await partExists(ac, hi)) {
    lo = hi;
    hi *= 2;
    if (hi > 4096) throw new Error(`AC ${ac}: no upper bound below ${hi} parts`);
  }
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await partExists(ac, mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

log('\nCounting polling parts on the CDN…');
let listed = 0;
let failed = 0;

const results = await pool(acs, concurrency, async (ac) => {
  try {
    const n = await countParts(ac.acNumber);
    listed += n;
    // No partId and no partName: neither is published on the CDN, and the stale
    // CEO names are not safe to borrow (see the note at the top of this file).
    const parts = Array.from({ length: n }, (_, i) => ({
      partId: null,
      partNumber: i + 1,
      partName: '',
      districtCd: ac.districtCd
    }));
    return { ...ac, parts };
  } catch (err) {
    failed++;
    return { ...ac, parts: [], error: err.message };
  }
}, (done, total) => progress(`  ${done}/${total} ACs, ${listed} parts, ${failed} failed`));
progress('');

log(`  ${listed} parts across ${results.filter((r) => r.parts.length).length} constituencies`);
if (failed) {
  log(`  ${failed} constituencies could not be counted:`);
  for (const r of results.filter((x) => x.error)) log(`    ${r.acNumber} ${r.name} — ${r.error}`);
}

const stillEmpty = results.filter((r) => !r.parts.length);
if (stillEmpty.length === results.length) {
  log('\n  No part list from either source. Nothing was overwritten — a manifest');
  log('  with no parts would make every later stage report an empty state.');
  process.exit(1);
}
if (stillEmpty.length) {
  log(`\n  ${stillEmpty.length} constituencies have no part list: ` +
      stillEmpty.map((r) => `${r.acNumber} ${r.name}`).join(', '));
}

// ------------------------------------------------------------ write

await writeJson(resolve(CACHE, 'manifest.json'), {
  state: STATE,
  rollType,
  discoveredAt: new Date().toISOString(),
  districts,
  constituencies: results
});

// A compact index for the site, so the AC picker does not need the part tree.
await writeJson(resolve(CACHE, 'ac-index.json'), results.map((r) => ({
  ac: r.acNumber, name: r.name, nameKn: r.nameKn, district: r.district,
  districtCd: r.districtCd, parts: r.parts.length
})), true);

log(`\nWrote cache/manifest.json — ${districts.length} districts, ${acs.length} ACs, ${listed} parts.`);
