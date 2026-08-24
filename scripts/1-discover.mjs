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
 *   node scripts/1-discover.mjs --district S1031,S1032,S1033
 *   node scripts/1-discover.mjs --roll-type S10-2026-SIR-DR
 *
 * A run scoped with --district is additive: it merges into any existing
 * cache/manifest.json rather than replacing it, so growing the state one
 * priority batch at a time never forgets a district discovered earlier.
 * `2-extract.py` reads constituencies from that manifest in array order, so
 * the merge keeps every earlier district ahead of whatever this run adds —
 * that ordering *is* the extraction queue, with no separate scheduler needed.
 * A bare run with no --district is the one exception: it means "the whole
 * state", so it replaces the file outright rather than merging into it.
 */

import { spawn } from 'node:child_process';
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
const onlyDistricts = argValue('--district')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
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

/* Does this part exist?
 *
 * A missing part is a clean 404 and a present one is a 200. Anything else is
 * treated as unknown and retried, so a flaky response never shortens a
 * constituency — a short count would silently drop real booths.
 *
 * Two things the CDN cares about that a bare `fetch` does not send:
 *
 *  - A browser user-agent. Node sends `node`, and the edge in front of the roll
 *    files answers some clients differently than it answers a browser.
 *  - A fallback away from HEAD. Every part probe wants only "does this exist",
 *    which is what HEAD is for, but an edge that dislikes HEAD will answer it
 *    with neither 200 nor 404. So an inconclusive HEAD is retried as a
 *    one-byte ranged GET, which costs nothing and is an ordinary read.
 *
 * And one the edge cares about that no header can express: **which HTTP client
 * is asking.** On a GitHub-hosted runner every shape above came back `406 Not
 * Acceptable`, while the gateway API on a different host answered the same
 * runner fine — so the refusal is this edge's, and it is either the runner's IP
 * or its client fingerprint. Node's `fetch` (undici) differs from curl in TLS
 * handshake, ALPN and header casing — undici lower-cases header names, browsers
 * and curl do not — and edge bot rules key on exactly that. So a request that
 * undici cannot get a straight answer to is tried once more through curl.
 *
 * curl is a fallback, never the default: on a host where `fetch` works it never
 * runs, so the local path is unchanged and stays free of a subprocess per probe.
 * If curl succeeds where `fetch` was refused, that is the fingerprint answer and
 * `2-extract.py` needs the same treatment for its `urllib` downloads.
 *
 * The status of the last inconclusive answer is carried into the thrown error,
 * because a WAF challenge, a geo-block and an origin timeout are all "not 404"
 * and only the number distinguishes them.
 */
const PROBE_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'application/pdf,*/*',
  'accept-language': 'en-IN,en;q=0.9',
  referer: 'https://voters.eci.gov.in/'
};

/* Set ROLL_PROBE=curl to skip undici entirely. Only used to exercise the
 * fallback on a machine where `fetch` works perfectly well. */
const forcedTransport = process.env.ROLL_PROBE ?? '';

const verdict = (status) =>
  status === 404 ? { exists: false }
    : status >= 200 && status < 300 ? { exists: true }
      : { status };

async function probeFetch(url, method) {
  const headers = { ...PROBE_HEADERS };
  if (method === 'GET') headers.range = 'bytes=0-0';
  const res = await fetch(url, { method, headers, redirect: 'follow' });
  return verdict(res.status);
}

/* Same request, spoken by curl. `-o /dev/null -w %{http_code}` because the
 * status is the entire answer — a part probe never wants the bytes. */
function probeCurl(url, method) {
  const args = ['-s', '-L', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '60'];
  args.push(...(method === 'HEAD' ? ['-I'] : ['-r', 'bytes=0-0']));
  for (const [k, v] of Object.entries(PROBE_HEADERS)) args.push('-H', `${k}: ${v}`);
  args.push(url);

  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const p = spawn('curl', args);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error(`curl unavailable: ${e.message}`)));
    p.on('close', () => {
      const status = Number(out.trim().slice(-3));
      if (!Number.isFinite(status) || status === 0) {
        reject(new Error(err.trim().split('\n').pop() || 'curl gave no status'));
      } else {
        resolve(verdict(status));
      }
    });
  });
}

/* The ladder, cheapest and most likely first. A HEAD over undici answers on any
 * healthy host; the ranged GET covers an edge that dislikes HEAD; curl covers an
 * edge that dislikes undici. Only the first attempt is cheap-only — once
 * something has already come back inconclusive, every transport is worth trying
 * before a constituency is written off. */
const LADDER = forcedTransport === 'curl'
  ? [['curl', probeCurl, 'HEAD'], ['curl', probeCurl, 'GET']]
  : [['fetch', probeFetch, 'HEAD'], ['fetch', probeFetch, 'GET'], ['curl', probeCurl, 'GET']];

async function partExists(ac, part, tries = 3) {
  const url = partUrl(ac, part);
  let last = 'no response';
  for (let attempt = 1; attempt <= tries; attempt++) {
    for (const [name, transport, method] of attempt === 1 ? LADDER.slice(0, 1) : LADDER) {
      try {
        const r = await transport(url, method);
        if (r.exists !== undefined) return r.exists;
        last = `${name} ${method} -> HTTP ${r.status}`;
      } catch (err) {
        last = `${name} ${method} -> ${err.message}`;
      }
    }
    if (attempt < tries) await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
  }
  throw new Error(`AC ${ac} part ${part}: ${last}`);
}

await mkdir(CACHE, { recursive: true });

// ------------------------------------------------------------ districts + ACs

log('Listing districts…');
let districts = (await getJson(`${GATEWAY}/common/districts/${STATE}`))
  .filter((d) => !onlyDistricts || onlyDistricts.includes(d.districtCd))
  .map((d) => ({
    districtCd: d.districtCd,
    districtNo: +d.districtNo,
    name: d.districtValue.trim(),
    nameKn: (d.districtValueHindi ?? '').trim()
  }));
// A whole-state run has no priority to preserve, so it keeps the old,
// predictable districtNo order. A scoped run's order IS the extraction queue
// (see the file header), so it is sorted to match --district exactly as typed
// rather than however the gateway happened to list them.
districts = onlyDistricts
  ? onlyDistricts.map((cd) => districts.find((d) => d.districtCd === cd)).filter(Boolean)
  : districts.sort((a, b) => a.districtNo - b.districtNo);
log(`  ${districts.length} districts`);

log('Listing assembly constituencies…');
// Each worker RETURNS its district's ACs rather than pushing into a shared
// array — `pool` resolves in input order regardless of which fetch lands
// first, but a side-effecting push does not, and with several districts
// racing over the network that was silently reshuffling the queue.
const acsByDistrict = await pool(districts, concurrency, async (d) => {
  const list = await getJson(`${GATEWAY}/common/acs/${d.districtCd}`);
  return list.map((a) => ({
    acNumber: +a.asmblyNo,
    name: (a.asmblyName ?? '').trim(),
    nameKn: (a.asmblyNameL1 ?? '').trim(),
    category: (a.category ?? '').trim(),
    districtCd: d.districtCd,
    district: d.name
  }));
}, (done, total) => progress(`  ${done}/${total} districts`));
progress('');
const acs = acsByDistrict.flat();
// Same split as above: a scoped run's district-then-AC order is the queue and
// must survive; a whole-state run keeps the old flat acNumber order.
if (!onlyDistricts) acs.sort((a, b) => a.acNumber - b.acNumber);
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
  for (const r of results.filter((x) => x.error)) log(`    ${r.name} — ${r.error}`);
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

/* A scoped run merges into whatever is already on disk instead of replacing
 * it: keep every previously-discovered district and AC in its existing
 * position (their part counts and any in-flight extraction they represent
 * are still valid), update entries this run re-discovered, and append
 * anything genuinely new in the order --district named it. That ordering is
 * the extraction queue (see the file header) — a whole-state run has no
 * "previous" scope to protect, so it still replaces the file outright. */
const mergeByKey = (prevList, freshList, key) => {
  const fresh = new Map(freshList.map((x) => [x[key], x]));
  const kept = prevList.map((x) => fresh.get(x[key]) ?? x);
  const known = new Set(prevList.map((x) => x[key]));
  return [...kept, ...freshList.filter((x) => !known.has(x[key]))];
};

const finalDistricts = onlyDistricts && previous?.districts
  ? mergeByKey(previous.districts, districts, 'districtCd')
  : districts;
const finalConstituencies = onlyDistricts && previous?.constituencies
  ? mergeByKey(previous.constituencies, results, 'acNumber')
  : results;

await writeJson(resolve(CACHE, 'manifest.json'), {
  state: STATE,
  rollType,
  discoveredAt: new Date().toISOString(),
  districts: finalDistricts,
  constituencies: finalConstituencies
});

// A compact index for the site, so the AC picker does not need the part tree.
// Built from the merged list — the site's picker needs every district
// discovered so far, not just the ones this particular run touched.
await writeJson(resolve(CACHE, 'ac-index.json'), finalConstituencies.map((r) => ({
  ac: r.acNumber, name: r.name, nameKn: r.nameKn, district: r.district,
  districtCd: r.districtCd, parts: r.parts.length
})), true);

const totalParts = finalConstituencies.reduce((n, c) => n + c.parts.length, 0);
log(`\nWrote cache/manifest.json — ${finalDistricts.length} districts, ` +
    `${finalConstituencies.length} ACs, ${totalParts} parts total ` +
    `(this run added ${listed} parts across ${districts.length} district(s)).`);
