/* Coverage-floor guard for the notices dataset — refuse to publish a build
 * where a constituency's row count collapsed versus the last committed build.
 *
 * Ported from the same author's karnataka-asddo-dashboard
 * (scripts/guard-district-coverage.mjs), which exists because Drive
 * throttling mid-import produced plausible-looking but truncated data
 * (Bagalkot 0, Mandya 17k of 168k) that silently overwrote good data. The
 * exact same failure shape applies here: a district's matrix job could get
 * partway through before Drive's per-runner quota (see HANDOFF.md's notices
 * section) cuts it off, producing a real but incomplete row count that this
 * script's caller would otherwise publish as if it were complete.
 *
 * Compares docs/data-notices/manifest.json's `acs` (freshly built) against a
 * snapshot of the PREVIOUS build (PREV_STATS, captured before the rebuild
 * overwrote it). Skipped when there is no previous build — this dataset's
 * first-ever import has nothing to compare against.
 *
 *   PREV_STATS=/tmp/prev-notices-stats.json node scripts/guard-notices-coverage.mjs
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DROP_FLOOR = Number(process.env.DROP_FLOOR ?? 0.7);
export const STATE_FLOOR = Number(process.env.STATE_FLOOR ?? 0.9);

export function assessCoverage(prev, cur, { dropFloor = DROP_FLOOR, stateFloor = STATE_FLOOR } = {}) {
  const prevAcs = prev?.acs ?? {};
  const prevByAc = new Map(Object.entries(prevAcs).map(([ac, v]) => [ac, v.partsWithData ?? 0]));
  if (!prevByAc.size) return { skip: true };

  const curAcs = cur?.acs ?? {};
  const curByAc = new Map(Object.entries(curAcs).map(([ac, v]) => [ac, v.partsWithData ?? 0]));

  const collapsed = [];
  for (const [ac, before] of prevByAc) {
    if (before > 20) {
      const now = curByAc.get(ac) ?? 0;
      if (now < before * dropFloor) {
        collapsed.push({ ac, before, now, pct: ((now / before) * 100).toFixed(0), vanished: !curByAc.has(ac) });
      }
    }
  }

  const prevTotal = prev?.rows ?? 0;
  const curTotal = cur?.rows ?? 0;
  const stateCollapse = prevTotal > 0 && curTotal < prevTotal * stateFloor
    ? { prevTotal, curTotal, pct: ((curTotal / prevTotal) * 100).toFixed(1) }
    : null;

  return { skip: false, collapsed, stateCollapse, dropFloor, stateFloor, acsChecked: curByAc.size };
}

async function main() {
  const prevPath = process.env.PREV_STATS ?? resolve('/tmp/prev-notices-stats.json');
  const load = async (p) => JSON.parse(await readFile(p, 'utf8').catch(() => '{"acs":{}}'));
  const prev = await load(prevPath);
  const cur = await load(resolve('docs/data-notices/manifest.json'));

  const r = assessCoverage(prev, cur);
  if (r.skip) {
    console.log('notices coverage guard: no previous build to compare against — skipping.');
    process.exit(0);
  }

  if (r.stateCollapse) {
    const { prevTotal, curTotal, pct } = r.stateCollapse;
    console.error(`::error::notices row total collapsed ${prevTotal} -> ${curTotal} (${pct}% of last build, floor ${(r.stateFloor * 100).toFixed(0)}%) — a partial/throttled import, not real data. Refusing to publish.`);
    process.exit(1);
  }

  if (r.collapsed.length) {
    console.error(`::error::${r.collapsed.length} AC(s) collapsed below ${(r.dropFloor * 100).toFixed(0)}% of the last build — a download/extraction failure, not real data. Refusing to publish.`);
    for (const c of r.collapsed) {
      console.error(`  AC ${c.ac}: ${c.before} -> ${c.now} parts with data (${c.pct}%)${c.vanished ? ' [VANISHED]' : ''}`);
    }
    process.exit(1);
  }

  console.log(`notices coverage guard OK: no AC fell below ${(r.dropFloor * 100).toFixed(0)}% and the total held above ${(r.stateFloor * 100).toFixed(0)}% of the last build (${r.acsChecked} ACs checked).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
