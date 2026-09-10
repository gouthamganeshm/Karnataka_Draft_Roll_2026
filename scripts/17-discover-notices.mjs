#!/usr/bin/env node
/* Stage 17 — discover the CEO's "notices issued" dataset.
 *
 * New third dataset, alongside the roll (stage 1-6) and ASD (stage 9-12):
 * https://ceo.karnataka.gov.in/notices_issued.html lists the electors given
 * notice for a discrepancy or "no mapping with last SIR", one PDF per part,
 * with a real text layer (columns: S.No, Part Serial, EPIC, Name, Age,
 * Gender, Reason) — no OCR needed, unlike the roll. See HANDOFF.md's
 * "notices feature" section for the full investigation.
 *
 * Unlike the roll/ASD CDN, this is not a deterministic path: it is 34
 * independently-uploaded Google Drive folders (one per district), each with
 * its own folder depth before reaching the actual per-part PDFs — BBMP
 * Central nests through an extra "{ac}-{name}" folder, Kodagu does not, and
 * more variants are expected across the rest. This script therefore walks
 * each district's tree generically (`scripts/lib/gdrive.mjs`) rather than
 * assuming one fixed depth, stopping at whichever folder actually holds the
 * `..._partN.pdf` files.
 *
 * Writes ONLY to cache/notices-manifest.json — never touches
 * cache/manifest.json, cache/rows/, or cache/asd-rows/, so this cannot
 * disturb the roll or ASD datasets no matter what it finds.
 *
 *     node scripts/17-discover-notices.mjs                # all 34 districts
 *     node scripts/17-discover-notices.mjs --district Kodagu,"BBMP Central"
 */

import { resolve } from 'node:path';
import { CACHE, log, pool, sleep, writeJson } from './lib/common.mjs';
import { listFolder } from './lib/gdrive.mjs';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const onlyDistricts = argValue('--district')?.split(',').map((s) => s.trim());
const MAX_DEPTH = 6;

/* Hand-transcribed from https://ceo.karnataka.gov.in/notices_issued.html —
 * the CEO does not publish this as structured data either, same situation as
 * app.js's CEO_OFFICIAL_ELECTORS. Re-scrape that page if a district's folder
 * ever moves. */
const DISTRICT_FOLDERS = {
  'BBMP Central': '1qTM---AuN7dEu7-hJrMAUOVAJdTMkV7x',
  'BBMP North': '1fRha0qA3vjhgf5dYpWTTEiP_DY56qOig',
  'BBMP South': '1N4NW1FZVNKMwFpCqXsFp5Ouo-xlzJFkp',
  Bagalkot: '1wYwL70UBcm7z4_7F5BgoYIB7iUSTnYwj',
  'Bangalore Rural': '1bzoI2GxURGOtLvqVc8o0jAyoNvJ0Zhgw',
  'Bangalore Urban': '1fUxpmUCH1SRxsNkPzmzra7fcztb9hFk0',
  Belgaum: '13foCIO2depQsEltcxLy6qqwJCBeXbVwN',
  Bellary: '1Q8SuyGSTClbiTZv1m2vapA9J8pKrKVWu',
  Bidar: '1Xq1T_cmGrEQ5BMS5rdny_7TEup2oDwDl',
  Chamarajanagar: '1Ffvbp7HQ7XHc8ji7EyPojeQ8S3xZvUNF',
  Chikkaballapur: '1SAb_4Bw70AS27GKj1dKYF46h6MIUX_y3',
  Chikkamagalur: '1ZHNoJCwH5x4HA6PwJwdkiKD4PfcRuMu_',
  Chitradurga: '15kdxOBogzEawR8dghSZWXJkFZwEnuZyV',
  'Dakshina Kannada': '1etqwGKtt4_lTpM7KvxCs2YuZZID1TNxa',
  Davanagere: '1L8NAYUNt4JLHy9hDt-VFE-hStW7D4j2_',
  Dharwad: '1i734w_bNnBK7wXjq-k-MqHnGq0okfURV',
  Gadag: '1sKN9mHWAsBXDsAO-sLDQczy-ipgpVpLD',
  Gulbarga: '1PRySOKO5yqBbRoqiI_kXeTlBfyDG21vw',
  Hassan: '1JSqIaFKUKW8oPNL4hC-8oltrwlUkNQPT',
  Haveri: '1J2WZDhf--qi0AOA0UfIOEdbz2YyYUROM',
  Kodagu: '1zh54tXmxr-BfAza2uqJfLpsIg1RZ_P5a',
  Kolar: '1drF7259zyvSr6UmhJr5Gk-rYoC-jwuTx',
  Koppal: '1g7hpZr58R3E5NOBXwgr4ZTUaJx6dDbX5',
  Mandya: '1pAG4LVNV165YMvLEizrnVjv146si-0jJ',
  Mysore: '1l3y2IP5SMyD5Sk4I0S-RvmjGMZJCNhdc',
  Raichur: '1yyVTnX3JxjAzCRKvMWbK9pja5qK3T7ae',
  Ramanagara: '1HWZivIJrY0B0O-Sf0odH--JS1gNcZReG',
  Shimoga: '10X2J54KZ3o0wHHQbk8cq-TVOeIYj2oIC',
  Tumkur: '1CxPwRcF_HO2g70QW1ttrNYtuGilCPRfu',
  Udupi: '1iJhbi3jrOxXy7igSPpuusgpZoieN_1_u',
  'Uttara Kannada': '1ygNrgoiSyPEIWv3HqhEAP37JqkarEKmO',
  Vijayanagara: '16KSoRpSRztXVnCHpjEZQtlS4xsKK_GXl',
  Vijayapura: '1E0uH1P8FJ9z5L7OW0PO5dK4ikSczWKpX',
  Yadgir: '1lDuv-b0XM3083pap3THDYvGQs_UAWAQD'
};

/* Deliberately no filename filter here. The first version of this script
 * only kept files matching one "..._ac{n}_part{n}.pdf" pattern and silently
 * dropped everything else — which is exactly how it missed AC163 entirely
 * (its files are named "S10_163_100_{booth name}_{date}.pdf", no "part"
 * substring at all) and 11 of Belgaum's 18 ACs, with no error or log line to
 * say so. At least 3 filename conventions and 2 different PDF content
 * templates are already known to coexist across districts (see HANDOFF.md).
 * Identifying the AC and part number is deferred entirely to the extraction
 * stage (18-extract-notices.py), which can read each PDF's own header text
 * as the authoritative source — far more reliable than guessing from
 * whichever naming convention that particular office happened to use. This
 * stage's only job is: find every PDF, wherever it is nested, and record
 * which ancestor folder names led to it (a strong hint for extraction when
 * the PDF itself has no header, e.g. "163-Shantinagar" implies ac=163 even
 * without ever parsing a filename). */

/** Walk one district's tree, collecting every PDF found at any depth,
 * however it is named. Also collects `.zip` archives — found 2026-09-09 in
 * Vijayanagara, where 4 of 5 ACs (Hadagali, Hagaribommanahalli, Vijayanagara,
 * Harapanahalli) upload one zip of per-part PDFs instead of individual
 * files; the earlier PDF-only filter made those folders look completely
 * empty, with nothing to say a real file was sitting there unread.
 * `18-extract-notices.py` unzips and parses each member exactly like a
 * standalone PDF — no `notices_parser.py` changes needed, since the PDFs
 * inside are the same Template A content, verified directly against one.
 * `.rar`/`.7z` archives are deliberately NOT extracted (no Python stdlib
 * support, and only one has ever been seen statewide — Ramanagara) but are
 * still recorded and reported, so a real file is never silently invisible
 * the way the zips were before this fix. */
async function crawlOnce(rootId) {
  const files = []; // { fileId, name, path: [ancestor folder names] }
  const unhandledArchives = []; // rar/7z — found, not extracted
  const seen = new Set();

  async function walk(folderId, depth, path) {
    if (depth > MAX_DEPTH || seen.has(folderId)) return;
    seen.add(folderId);
    const entries = await listFolder(folderId);
    for (const e of entries) {
      if (e.kind !== 'file') continue;
      if (/\.pdf$/i.test(e.name)) {
        files.push({ fileId: e.id, name: e.name, path });
      } else if (/\.zip$/i.test(e.name)) {
        files.push({ fileId: e.id, name: e.name, path, kind: 'zip' });
      } else if (/\.(rar|7z)$/i.test(e.name)) {
        unhandledArchives.push({ name: e.name, path: path.join('/') });
      }
    }
    for (const sub of entries.filter((e) => e.kind === 'folder')) {
      await walk(sub.id, depth + 1, [...path, sub.name]);
    }
  }

  await walk(rootId, 0, []);
  return { files, unhandledArchives };
}

/* A statewide run found Belgaum, Bellary and Tumkur — all three confirmed
 * to have real files in an earlier, uncontended local run (1,456, 703 and
 * 866 PDFs respectively) — coming back with 0 files and no error at all.
 * `listFolder`'s own retries only cover a request that outright failed; a
 * request that returns HTTP 200 with a genuinely empty (or truncated)
 * parse under load looks identical to a real empty folder like Davanagere's,
 * and nothing was checking for that difference. This is exactly the
 * "silent narrowing" failure karnataka-asddo-dashboard's own history
 * warns about (a district present at the source but missing from the
 * import, with nothing flagging it) — so a 0-file result is now treated as
 * suspicious enough to double-check, not accepted on the first pass. */
async function crawlDistrict(district, rootId) {
  let { files, unhandledArchives } = await crawlOnce(rootId);
  for (let attempt = 1; files.length === 0 && attempt <= 2; attempt++) {
    await sleep(3000 * attempt);
    log(`  ${district}: came back empty, re-checking (attempt ${attempt + 1})...`);
    ({ files, unhandledArchives } = await crawlOnce(rootId));
  }
  return { files, unhandledArchives };
}

async function main() {
  const districts = Object.keys(DISTRICT_FOLDERS).filter(
    (d) => !onlyDistricts || onlyDistricts.includes(d)
  );
  log(`Discovering notices data for ${districts.length} district(s)...`);

  // Kept modest on purpose: the 401s documented in gdrive.mjs's listFolder
  // comment showed up at concurrency 4, and this is a burst-sensitive
  // endpoint, not a total-volume one — the download quota needed ~10,000
  // files, this needed a handful of districts' worth of simultaneous
  // listings.
  const results = await pool(districts, 2, async (district) => {
    const rootId = DISTRICT_FOLDERS[district];
    try {
      const { files, unhandledArchives } = await crawlDistrict(district, rootId);
      const zipCount = files.filter((f) => f.kind === 'zip').length;
      const zipNote = zipCount ? ` (${zipCount} as .zip)` : '';
      log(`  ${district}: ${files.length} PDF(s) found${zipNote}`);
      if (unhandledArchives.length) {
        log(`  ${district}: ${unhandledArchives.length} unhandled archive(s) NOT extracted — ` +
            unhandledArchives.map((a) => `${a.path}/${a.name}`).join(', '));
      }
      return { district, files, unhandledArchives };
    } catch (err) {
      log(`  ${district}: FAILED — ${err.message}`);
      return { district, files: [], unhandledArchives: [], error: err.message };
    }
  });

  // Flat list — identifying AC/part is 18-extract-notices.py's job, using
  // each PDF's own content as the authority. `path` (the chain of ancestor
  // folder names) travels with each file since it is often the only signal
  // available when a PDF has no header of its own (see AC163 above).
  const allFiles = [];
  const errors = [];
  const allUnhandledArchives = [];
  for (const { district, files, unhandledArchives, error } of results) {
    if (error) errors.push({ district, error });
    for (const f of files) allFiles.push({ district, ...f });
    for (const a of unhandledArchives) allUnhandledArchives.push({ district, ...a });
  }

  await writeJson(
    resolve(CACHE, 'notices-manifest.json'),
    { files: allFiles, errors, unhandledArchives: allUnhandledArchives },
    true
  );

  log(`\nDone. ${allFiles.length} PDF(s) found across ${districts.length} district(s), ` +
      `${errors.length} district-level failure(s), ${allUnhandledArchives.length} unhandled archive(s).`);
  log('Wrote cache/notices-manifest.json — extraction determines AC/part per file.');
}

main();
