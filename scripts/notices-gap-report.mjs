/* Per-district notices shortfall: live published rows vs the CEO press note's
 * Annexure-2 counts (CEO_OFFICIAL_NOTICES in docs/app.js), with the ACs that
 * have no data at all. Needs only the repo and network, no cache/.
 *
 *     node scripts/notices-gap-report.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync('docs/app.js', 'utf8');
const CEO = eval('(' + src.match(/const CEO_OFFICIAL_NOTICES = (\{[\s\S]*?\});/)[1] + ')');
const seed = JSON.parse(fs.readFileSync('seed/ac-metadata.json', 'utf8'));
const live = await (await fetch(
  `https://gouthamganeshm.github.io/Karnataka_Draft_Roll_2026/data-notices/manifest.json?_=${Date.now()}`)).json();

const ours = {};
const noData = {};
for (const c of seed.constituencies) {
  const rows = live.acs[c.acNumber]?.rows ?? 0;
  ours[c.district] = (ours[c.district] || 0) + rows;
  if (!rows) (noData[c.district] ||= []).push(c.acNumber);
}
const table = Object.keys(CEO)
  .map((d) => ({ d, ours: ours[d] || 0, ceo: CEO[d], gap: CEO[d] - (ours[d] || 0) }))
  .sort((a, b) => b.gap - a.gap);
for (const r of table) {
  console.log(r.d.padEnd(18), String(r.ours).padStart(8), String(r.ceo).padStart(8),
    String(r.gap).padStart(7), `${(r.ours / r.ceo * 100).toFixed(1)}%`,
    noData[r.d] ? `no-data ACs: ${noData[r.d].join(',')}` : '');
}
const ceoTotal = Object.values(CEO).reduce((a, b) => a + b, 0);
console.log(`live ${live.rows} (built ${live.builtAt}) vs CEO ${ceoTotal}: ${(live.rows / ceoTotal * 100).toFixed(2)}%`);
