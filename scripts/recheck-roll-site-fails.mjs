/* Re-checks every roll 'site' failure in test-logs/test-log.jsonl against the
 * live site today, separating transient failures (load, Pages hiccups) from
 * records still wrong live. Writes cache/recheck-roll-site-fails.json.
 * HANDOFF.md section 17. */
import fs from 'node:fs'; import { createHash } from 'node:crypto';
const BASE = 'https://gouthamganeshm.github.io/Karnataka_Draft_Roll_2026/data/';
const m = await (await fetch(BASE + 'manifest.json?_=' + Date.now())).json();
const fails = fs.readFileSync('test-logs/test-log.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  .filter(r => r.dataset === 'roll' && r.layer === 'site' && r.verdict === 'fail');
const cache = new Map(); const out = { nowPass: 0, stillFail: [] };
for (const r of fails) {
  const h = createHash('sha256').update(r.epic).digest('hex');
  const p = h.slice(0, m.shardDepth), s = h.slice(m.shardDepth, m.shardDepth + m.suffixLength);
  const path = p.length > 2 ? `roll/${p.slice(0, 2)}/${p.slice(2)}.json` : `roll/${p}.json`;
  if (!cache.has(path)) { const res = await fetch(BASE + path); cache.set(path, res.ok ? await res.json() : []); }
  const b = cache.get(path); const recs = (Array.isArray(b) ? b : b.records).filter(x => x[0] === s);
  const ok = recs.some(x => x[1] === r.expected.ac && x[2] === r.expected.part && x[3] === r.expected.serial);
  if (ok) out.nowPass++; else out.stillFail.push({ ts: r.timestamp.slice(0, 10), epic: r.epic, expected: r.expected, live: recs, logged: r.actual ?? r.error });
}
console.log('site fails', fails.length, 'now pass', out.nowPass, 'still fail', out.stillFail.length);
for (const f of out.stillFail.slice(0, 12)) console.log(JSON.stringify(f));
fs.writeFileSync('cache/recheck-roll-site-fails.json', JSON.stringify(out, null, 1));
