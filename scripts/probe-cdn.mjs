#!/usr/bin/env node
/* Can this host read the roll PDFs at all?
 *
 * The whole pipeline rests on one assumption: every published part PDF is a
 * plain public GET on ECI's CDN. That holds from a desktop in India — verified
 * repeatedly, 200 on HEAD and 206 on a ranged GET. It did *not* hold on a
 * GitHub-hosted runner, which was answered `406 Not Acceptable` for all seven
 * constituencies in the Bangalore Urban district while the gateway API on a
 * different host answered the same runner perfectly.
 *
 * A 406 is an edge decision, and only two things can be driving it:
 *
 *   - the caller's IP, in which case no amount of header shaping helps and a
 *     hosted runner simply cannot do this job; or
 *   - the caller's *fingerprint* — Node's `fetch` (undici) presents a different
 *     TLS handshake, header order and ALPN than curl does, and edge bot rules
 *     routinely key on exactly that — in which case shelling out to curl fixes
 *     it outright.
 *
 * Those two have completely different remedies, so guessing between them is
 * expensive. This script asks both questions in one ~20-second run: the same
 * URL through several request shapes over both transports, plus a part number
 * that is known not to exist, because an edge that has stopped returning honest
 * 404s would silently truncate every constituency count.
 *
 *     node scripts/probe-cdn.mjs                 # AC 177 part 1
 *     node scripts/probe-cdn.mjs --ac 176 --part 605
 *
 * Exits non-zero when nothing worked, so a workflow step fails loudly rather
 * than scrolling past.
 */

import { spawn } from 'node:child_process';
import { log } from './lib/common.mjs';

const CDN = 'https://voters.eci.gov.in/eroll/2026/s10/sir-draftroll';
const partUrl = (ac, part) =>
  `${CDN}/${ac}/2026-EROLLGEN-S10-${ac}-SIR-DraftRoll-Revision1-KAN-${part}-WI.pdf`;

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};

const ac = Number(argValue('--ac') ?? 177);
const part = Number(argValue('--part') ?? 1);
const timeoutMs = Number(argValue('--timeout') ?? 45000);

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'application/pdf,*/*',
  'accept-language': 'en-IN,en;q=0.9',
  referer: 'https://voters.eci.gov.in/'
};

// ------------------------------------------------------------------ transports

async function viaFetch(url, { method, headers }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, redirect: 'follow', signal: ctl.signal });
    // Drain, or the socket is left holding a body we never asked to keep.
    await res.arrayBuffer().catch(() => {});
    return { status: res.status, note: res.headers.get('server') ?? '' };
  } catch (err) {
    return { status: 0, note: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/* curl is the control case. It is on every GitHub runner and on the author's
 * machine, and it is the transport whose success or failure separates "this IP
 * is denied" from "this HTTP client is denied". */
function viaCurl(url, { method, headers, extra = [] }) {
  const args = [
    '-s', '-o', '/dev/null',
    '-w', '%{http_code}',
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    ...extra
  ];
  if (method === 'HEAD') args.push('-I');
  else args.push('-r', '0-0');
  for (const [k, v] of Object.entries(headers ?? {})) args.push('-H', `${k}: ${v}`);
  args.push(url);

  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const p = spawn('curl', args);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ status: 0, note: `curl unavailable: ${e.message}` }));
    p.on('close', () => {
      const code = Number(out.trim());
      resolve(Number.isFinite(code) && code > 0
        ? { status: code, note: '' }
        : { status: 0, note: err.trim().split('\n').pop() || 'no status' });
    });
  });
}

// ---------------------------------------------------------------------- shapes

const shapes = [
  ['fetch  HEAD  bare',          viaFetch, { method: 'HEAD' }],
  ['fetch  HEAD  browser',       viaFetch, { method: 'HEAD', headers: BROWSER }],
  ['fetch  GET   bare',          viaFetch, { method: 'GET', headers: { range: 'bytes=0-0' } }],
  ['fetch  GET   browser',       viaFetch, { method: 'GET', headers: { ...BROWSER, range: 'bytes=0-0' } }],
  ['curl   HEAD  bare',          viaCurl,  { method: 'HEAD' }],
  ['curl   HEAD  browser',       viaCurl,  { method: 'HEAD', headers: BROWSER }],
  ['curl   GET   browser',       viaCurl,  { method: 'GET', headers: BROWSER }],
  // HTTP/2 vs 1.1 changes the frame and header casing an edge sees. Cheap to
  // rule in or out while we are here.
  ['curl   GET   browser h1',    viaCurl,  { method: 'GET', headers: BROWSER, extra: ['--http1.1'] }]
];

// ------------------------------------------------------------------------ run

log(`Probing the roll CDN from this host — AC ${ac} part ${part}`);
log(`  ${partUrl(ac, part)}\n`);

/* Worth printing even though it is not acted on: if a runner is ever unblocked,
 * the difference will be visible here and nowhere else. */
const ip = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(15000) })
  .then((r) => r.text())
  .catch(() => '(unavailable)');
log(`Egress IP: ${ip.trim()}\n`);

const url = partUrl(ac, part);
const results = [];
for (const [name, transport, opts] of shapes) {
  const r = await transport(url, opts);
  results.push({ name, ...r });
  const verdict = r.status === 200 || r.status === 206 ? 'OK' : r.status === 404 ? 'MISSING' : 'BLOCKED';
  log(`  ${name.padEnd(24)} ${String(r.status || '—').padEnd(5)} ${verdict.padEnd(8)} ${r.note}`);
}

/* A part far past the end of any constituency in the state. This must be a 404.
 * If the edge answers it 200, the doubling search in `1-discover.mjs` never
 * finds an upper bound; if it answers 406, the search cannot tell "absent" from
 * "refused" and would count every constituency short. */
log('');
const missing = await viaCurl(partUrl(ac, 9999), { method: 'GET', headers: BROWSER });
log(`  ${'known-missing part 9999'.padEnd(24)} ${String(missing.status || '—').padEnd(5)} ` +
    `${missing.status === 404 ? 'honest 404' : 'NOT a 404 — counts would be wrong'}`);

// --------------------------------------------------------------------- verdict

const working = results.filter((r) => r.status === 200 || r.status === 206);
const fetchOk = working.some((r) => r.name.startsWith('fetch'));
const curlOk = working.some((r) => r.name.startsWith('curl'));

log('\n' + '-'.repeat(66));
if (!working.length) {
  const statuses = [...new Set(results.map((r) => r.status || r.note))].join(', ');
  log('VERDICT: this host cannot read the roll PDFs. Every shape failed');
  log(`         (${statuses}). No header or transport change fixes an IP-level`);
  log('         denial — the run needs an egress the edge accepts.');
  process.exit(1);
}
if (fetchOk && curlOk) {
  log('VERDICT: the CDN is fully readable from this host. Nothing to work around.');
} else if (curlOk) {
  log('VERDICT: curl is served but Node\'s fetch is not — the edge is refusing the');
  log('         HTTP client, not the IP. Route part fetches through curl.');
} else {
  log('VERDICT: Node\'s fetch is served but curl is not, which is the reverse of the');
  log('         expected failure. Keep fetch and record this before changing anything.');
}
log(`         ${working.length}/${results.length} shapes returned a PDF.`);
