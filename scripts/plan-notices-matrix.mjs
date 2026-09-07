/* Plan the notices-import GitHub Actions matrix — one job per district.
 *
 * Modelled directly on the same author's karnataka-asddo-dashboard
 * (scripts/plan-matrix.mjs there), which solved the identical problem
 * (per-district Google Drive PDFs, Drive's own throttling) months earlier.
 * Reused rather than reinvented: sort longest-district-first so the slowest
 * job starts earliest and does not become the tail the whole matrix waits
 * on, and refuse to silently narrow coverage the way that project's own
 * `#28 incident` describes (a district present in the source but excluded
 * from the matrix must be a loud failure, not a quiet omission).
 *
 * Unlike that project's manifest (built with per-district structure already),
 * `17-discover-notices.mjs` writes a flat `{ files: [...] }` list with a
 * `district` field per file — grouping into a matrix is this script's job.
 *
 *   node scripts/plan-notices-matrix.mjs [--manifest path]
 *
 * Writes matrix/total/districts to GITHUB_OUTPUT when that is set.
 */

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE, log, readJson } from './lib/common.mjs';

const args = process.argv.slice(2);
const argValue = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };
const manifestPath = argValue('--manifest') ?? resolve(CACHE, 'notices-manifest.json');
const only = (argValue('--only') || process.env.ONLY_DISTRICTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Pure, so a test can call it without touching the filesystem. `only`, when
 * non-empty, restricts the matrix to those district names — for a cheap
 * trial run before committing to the full 32-district matrix. */
export function plan(manifest, { only = [] } = {}) {
  const byDistrict = new Map();
  for (const f of manifest.files ?? []) {
    if (only.length && !only.includes(f.district)) continue;
    if (!byDistrict.has(f.district)) byDistrict.set(f.district, 0);
    byDistrict.set(f.district, byDistrict.get(f.district) + 1);
  }
  const districts = [...byDistrict.entries()]
    .map(([name, files]) => ({ name, slug: slug(name), files }))
    .sort((a, b) => b.files - a.files);

  return {
    districts,
    total: districts.reduce((n, d) => n + d.files, 0),
    errors: manifest.errors ?? []
  };
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const manifest = await readJson(manifestPath);
  if (!manifest) {
    log(`::error::No manifest at ${manifestPath}`);
    process.exit(1);
  }

  const result = plan(manifest, { only });

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify({ include: result.districts })}\n` +
      `total=${result.total}\n` +
      `districts=${result.districts.length}\n`);
  }

  log(`${result.districts.length} districts, ${result.total} PDFs`);
  for (const e of result.errors) log(`::warning::district crawl failure: ${e.district} — ${e.error}`);

  if (!result.districts.length) {
    log('::error::No districts to import — refusing to plan an empty matrix.');
    process.exit(1);
  }
}
