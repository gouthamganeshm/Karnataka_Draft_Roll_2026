#!/usr/bin/env node
/* Stage 11 — spot-check a finished constituency's ASD data against the live
 * site. The ASD sibling of `7-verify.mjs`, same two-layer method, same
 * reason for existing: the pipeline already has its own honesty guard (a row
 * that fails validation is withheld — see `10-build-asd-data.mjs`), and this
 * is a second, independent one that trusts nothing and re-derives everything
 * from the source PDF.
 *
 *   1. Pipeline consistency. Rows from `cache/asd-rows/<ac>.jsonl` against
 *      the live site's real lookup path (SHA-256 -> docs-asd bucket ->
 *      binary search), over actual HTTP.
 *   2. Source-of-truth. Re-fetch the actual ASD report PDF and re-parse it
 *      with `asd_parser.py` independently — this is the layer that catches
 *      the parser itself being wrong, not just a broken build.
 *
 *     node scripts/11-verify-asd.mjs --ac 150
 *     node scripts/11-verify-asd.mjs --ac 150,153 --sample 12 --pdf-checks 2
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { CACHE, log, logTest } from './lib/common.mjs';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const acList = (argValue('--ac') ?? '').split(',').map((s) => +s.trim()).filter(Boolean);
const sampleSize = Number(argValue('--sample') ?? 12);
const pdfChecks = Number(argValue('--pdf-checks') ?? 2);
const site = argValue('--site') ?? 'https://gouthamganeshm.github.io/Karnataka_Draft_Roll_2026';

if (!acList.length) {
  log('Usage: node scripts/11-verify-asd.mjs --ac <acNo>[,<acNo>...] [--sample N] [--pdf-checks N]');
  process.exit(2);
}

const UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
const CDN = 'https://voters.eci.gov.in/eroll/asd/2026/s10';
const partUrl = (ac, part) => `${CDN}/${ac}/uncollectable_elector_report_ac${ac}_part${part}_KAN.pdf`;

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function findInBucket(records, suffix) {
  let lo = 0;
  let hi = records.length - 1;
  const hits = [];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = records[mid][0];
    if (v < suffix) lo = mid + 1;
    else if (v > suffix) hi = mid - 1;
    else {
      let i = mid;
      while (i >= 0 && records[i][0] === suffix) i--;
      for (let j = i + 1; j < records.length && records[j][0] === suffix; j++) hits.push(records[j]);
      break;
    }
  }
  return hits;
}

const bucketCache = new Map();
async function fetchBucket(prefix) {
  if (bucketCache.has(prefix)) return bucketCache.get(prefix);
  const path = prefix.length > 2 ? `roll/${prefix.slice(0, 2)}/${prefix.slice(2)}.json` : `roll/${prefix}.json`;
  const p = getJson(`${site}/data-asd/${path}`).catch(() => null);
  bucketCache.set(prefix, p);
  return p;
}

async function lookupLive(epic, manifest) {
  const hash = sha256hex(epic);
  const depth = manifest.shardDepth;
  const bucket = await fetchBucket(hash.slice(0, depth));
  if (!bucket) return [];
  return findInBucket(bucket, hash.slice(depth, depth + manifest.suffixLength));
}

async function sampleRows(ac, n) {
  const rows = [];
  let seen = 0;
  const rl = createInterface({
    input: createReadStream(resolve(CACHE, 'asd-rows', `${ac}.jsonl`)),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row.ok) continue;
    seen++;
    if (rows.length < n) {
      rows.push(row);
    } else {
      const j = Math.floor(Math.random() * seen);
      if (j < n) rows[j] = row;
    }
  }
  return rows;
}

/* Re-reads the specific row off the source PDF, independent of every other
 * stage — never trusts asd_parser.py's own prior output for this row. */
async function verifyAgainstPdf(row) {
  const url = partUrl(row.ac, row.part);
  let buf;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://voters.eci.gov.in/' } });
      if (!res.ok) return { ok: false, reason: `PDF fetch ${res.status}` };
      buf = Buffer.from(await res.arrayBuffer());
      break;
    } catch (err) {
      if (attempt === 2) return { ok: false, reason: `PDF fetch failed twice: ${err.message}` };
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const { spawnSync } = await import('node:child_process');
  const script = `
import sys, json
sys.path.insert(0, 'scripts/ocr')
from asd_parser import read_asd_bytes
data = sys.stdin.buffer.read()
rows, header = read_asd_bytes(data)
match = next((r for r in rows if r.epic == ${JSON.stringify(row.epic)}), None)
print(json.dumps({
  'found': match is not None,
  'serial': match.serial if match else None,
  'reasonCode': match.reasonCode if match else None,
  'oldPart': match.oldPart if match else None,
  'oldSerial': match.oldSerial if match else None,
  'name': match.name if match else None,
  'relativeName': match.relativeName if match else None,
  'total': len(rows)
}))
`;
  const r = spawnSync('python', ['-c', script], { input: buf, maxBuffer: 1024 * 1024 * 64 });
  if (r.status !== 0) return { ok: false, reason: `python exit ${r.status}: ${r.stderr?.toString().slice(-400)}` };
  let parsed;
  try {
    parsed = JSON.parse(r.stdout.toString().trim().split('\n').pop());
  } catch {
    return { ok: false, reason: 'could not parse ASD re-check output' };
  }
  if (!parsed.found) return { ok: false, reason: `EPIC not found on re-read of part ${row.part} (${parsed.total} rows read)` };
  const mismatches = [];
  if (parsed.serial !== row.serial) mismatches.push(`serial: row=${row.serial} reread=${parsed.serial}`);
  if (parsed.reasonCode !== row.reasonCode) mismatches.push(`reasonCode: row=${row.reasonCode} reread=${parsed.reasonCode}`);
  if (parsed.oldPart !== row.oldPart) mismatches.push(`oldPart: row=${row.oldPart} reread=${parsed.oldPart}`);
  if (parsed.oldSerial !== row.oldSerial) mismatches.push(`oldSerial: row=${row.oldSerial} reread=${parsed.oldSerial}`);
  if (parsed.name !== row.name) mismatches.push(`name: row=${JSON.stringify(row.name)} reread=${JSON.stringify(parsed.name)}`);
  if (parsed.relativeName !== row.relativeName) mismatches.push(`relativeName: row=${JSON.stringify(row.relativeName)} reread=${JSON.stringify(parsed.relativeName)}`);
  if (mismatches.length) return { ok: false, reason: mismatches.join('; ') };
  return { ok: true };
}

// ------------------------------------------------------------------------ run

let exitCode = 0;

for (const ac of acList) {
  log(`\n=== ASD AC ${ac} ===`);
  const manifest = await getJson(`${site}/data-asd/manifest.json`);
  const acMeta = manifest.acs[ac];
  if (!acMeta) {
    log(`  not in the live ASD manifest — skipping`);
    exitCode = 1;
    continue;
  }
  if (acMeta.partsDone < acMeta.parts) {
    log(`  not complete yet: ${acMeta.partsDone}/${acMeta.parts} — skipping`);
    continue;
  }

  try {
    const rows = await sampleRows(ac, sampleSize);
    log(`  sampled ${rows.length} rows from cache/asd-rows/${ac}.jsonl`);

    let mismatches = 0;
    for (const row of rows) {
      const hits = await lookupLive(row.epic, manifest);
      const match = hits.find((h) => h[1] === row.ac && h[2] === row.part && h[3] === row.serial);
      const fieldsOk = match && match[4] === row.reasonCode && match[5] === row.oldPart
        && match[6] === row.oldSerial && match[7] === row.name && match[8] === row.relativeName;
      if (!match) {
        mismatches++;
        log(`  FAIL  ${row.epic}  expected [${row.ac},${row.part},${row.serial}]  ` +
            `got ${JSON.stringify(hits)}`);
      } else if (!fieldsOk) {
        mismatches++;
        log(`  FAIL  ${row.epic}  published record disagrees with source row: `
          + `${JSON.stringify(match)} vs row ${JSON.stringify(row)}`);
      }
      await logTest({
        dataset: 'asd', layer: 'site', ac: row.ac, part: row.part, epic: row.epic,
        expected: { ac: row.ac, part: row.part, serial: row.serial, reasonCode: row.reasonCode, oldPart: row.oldPart, oldSerial: row.oldSerial },
        actual: hits, verdict: (match && fieldsOk) ? 'pass' : 'fail'
      });
    }
    log(`  live-site consistency: ${rows.length - mismatches}/${rows.length} matched`);

    const forPdf = rows.slice(0, Math.min(pdfChecks, rows.length));
    let pdfFails = 0;
    for (const row of forPdf) {
      const r = await verifyAgainstPdf(row);
      if (!r.ok) {
        pdfFails++;
        log(`  PDF-CHECK FAIL  ${row.epic}  part ${row.part}  — ${r.reason}`);
      } else {
        log(`  PDF-CHECK ok    ${row.epic}  part ${row.part}  serial ${row.serial}  ${row.reasonCode}`);
      }
      await logTest({
        dataset: 'asd', layer: 'pdf', ac: row.ac, part: row.part, epic: row.epic,
        expected: { serial: row.serial, reasonCode: row.reasonCode, oldPart: row.oldPart, oldSerial: row.oldSerial },
        verdict: r.ok ? 'pass' : 'fail', reason: r.reason ?? null
      });
    }

    if (mismatches || pdfFails) {
      log(`  ASD AC ${ac}: VERIFICATION FAILED (${mismatches} site mismatches, ${pdfFails} PDF mismatches)`);
      exitCode = 1;
    } else {
      log(`  ASD AC ${ac}: verified clean (${rows.length} sampled, ${forPdf.length} against source PDF)`);
    }
  } catch (err) {
    log(`  ASD AC ${ac}: verification run itself errored — ${err.message}`);
    exitCode = 1;
  }
}

// See 7-verify.mjs / 8-full-sweep.mjs for why this is exitCode, not process.exit().
process.exitCode = exitCode;
