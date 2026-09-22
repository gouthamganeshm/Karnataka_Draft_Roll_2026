/* Lists EVERY entry (any file type, any depth) in all 34 notices Drive trees and
 * reports what 17-discover-notices.mjs would not pick up: non-PDF/zip/rar/xlsx
 * files, folders deeper than its MAX_DEPTH, and per-folder entry counts (a
 * folder near 1,024 entries may be hitting a listing cap). Writes
 * cache/notices-drive-audit.json. HANDOFF.md section 16. */
import fs from 'node:fs';
import { get, sleep } from './lib/common.mjs';
const src = fs.readFileSync('scripts/17-discover-notices.mjs', 'utf8');
const DF = eval('(' + src.match(/const DISTRICT_FOLDERS = (\{[\s\S]*?\});/)[1] + ')');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ANY = /<a[^>]+href="([^"]+)"[^>]*>[\s\S]{0,1200}?flip-entry-title">([^<]+)</g;
async function list(id) {
  for (let t = 1; t <= 6; t++) {
    try { return (await get(`https://drive.google.com/embeddedfolderview?id=${id}#list`, { headers: { 'user-agent': UA } })).toString('utf8'); }
    catch (e) { await sleep(1500 * t * t); }
  }
  throw new Error('fail ' + id);
}
const out = { other: [], deep: [], counts: [], fails: [], rawMismatch: [] };
async function walk(district, id, depth, path) {
  let html; try { html = await list(id); } catch (e) { out.fails.push({ district, id, path }); return; }
  const titles = (html.match(/flip-entry-title/g) || []).length;
  const ents = [...html.matchAll(ANY)].map(m => ({ href: m[1], name: m[2].trim() }));
  if (ents.length !== titles) out.rawMismatch.push({ district, path, titles, parsed: ents.length });
  out.counts.push({ district, path: path.join('/'), n: ents.length });
  const subs = [];
  for (const e of ents) {
    const f = e.href.match(/drive\/folders\/([A-Za-z0-9_-]+)/);
    if (f) { subs.push({ id: f[1], name: e.name }); continue; }
    if (!/drive\.google\.com\/file\/d\//.test(e.href) || !/\.(pdf|zip|rar|7z|xlsx)$/i.test(e.name)) out.other.push({ district, path: path.join('/'), name: e.name, href: e.href.slice(0, 120) });
  }
  for (const s of subs) {
    if (depth + 1 > 6) { out.deep.push({ district, path: [...path, s.name].join('/') }); }
    await walk(district, s.id, depth + 1, [...path, s.name]);
  }
}
const ds = Object.entries(DF);
let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => { while (i < ds.length) { const [d, id] = ds[i++]; await walk(d, id, 0, [d]); console.log('done', d); } }));
fs.writeFileSync('cache/notices-drive-audit.json', JSON.stringify(out, null, 1));
console.log('other', out.other.length, 'deep', out.deep.length, 'fails', out.fails.length, 'mismatch', out.rawMismatch.length);
const hist = {}; for (const c of out.counts) hist[c.n] = (hist[c.n] || 0) + 1;
console.log('max entries in one folder', Math.max(...out.counts.map(c => c.n)));
