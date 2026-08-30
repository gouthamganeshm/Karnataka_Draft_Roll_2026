/* Shared helpers for the ingestion pipeline.
   Zero runtime dependencies on purpose: this has to keep working years from
   now on whatever Node the volunteer running it happens to have. */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// ROLL_CACHE / ROLL_DATA redirect the pipeline's input and output so a test can
// run the real stages over a fixture instead of the live multi-gigabyte tree.
export const CACHE = process.env.ROLL_CACHE ? resolve(process.env.ROLL_CACHE) : resolve(ROOT, 'cache');
export const DATA = process.env.ROLL_DATA ? resolve(process.env.ROLL_DATA) : resolve(ROOT, 'data');
export const DOCS = resolve(ROOT, 'docs');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Headers the ECI gateway expects. Without the origin/referer pair it 401s. */
export const ECI_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
  origin: 'https://voters.eci.gov.in',
  referer: 'https://voters.eci.gov.in/',
  'user-agent': UA,
  applicationname: 'VSP',
  channelidobculisapi: 'VSP',
  'platform-type': 'ECIWEB'
};

/** Fetch with retry + backoff. Returns a Buffer. */
export const get = async (url, opts) => (await getNamed(url, opts)).buf;

/** As `get`, but also returns the name the server gave the file. */
export async function getNamed(url, { tries = 4, timeoutMs = 60000, headers, method, body } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: method ?? 'GET',
        body,
        headers: { 'user-agent': UA, 'accept-language': 'en-IN,en;q=0.9', ...headers },
        redirect: 'follow',
        signal: ac.signal
      });
      if (!res.ok) {
        // Carry a snippet of the body: a geo-block, a WAF challenge and a
        // genuine 404 all arrive as a bare status code otherwise, and the
        // difference decides whether re-running could ever help.
        const snippet = (await res.text().catch(() => ''))
          .replace(/\s+/g, ' ')
          .slice(0, 200);
        throw new Error(`HTTP ${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ''}`);
      }
      const cd = res.headers.get('content-disposition') ?? '';
      const named = /filename\*=UTF-8''([^;]+)/i.exec(cd) ?? /filename="?([^";]+)"?/i.exec(cd);
      return {
        buf: Buffer.from(await res.arrayBuffer()),
        filename: named ? decodeURIComponent(named[1].trim()) : '',
        contentType: res.headers.get('content-type') ?? ''
      };
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await sleep(800 * attempt * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${method ?? 'GET'} ${url} failed after ${tries} tries: ${lastErr?.message}`);
}

export const getText = async (url, opts) => (await get(url, opts)).toString('utf8');

export const getJson = async (url, opts) =>
  JSON.parse(await getText(url, { headers: ECI_HEADERS, ...opts }));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `worker` over `items` with a fixed concurrency, reporting progress. */
export async function pool(items, concurrency, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: err.message };
      }
      done++;
      if (onProgress && (done % 25 === 0 || done === items.length)) onProgress(done, items.length);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------- files

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(path, value, pretty = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
}

export const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function log(...args) {
  process.stdout.write(args.join(' ') + '\n');
}

/** Shared test log book — test-logs/test-log.jsonl, committed (not
 * cache/, which is gitignored). Every verify/sweep script appends here so
 * there is one durable, git-tracked record of what was checked, when, and
 * with what result, instead of each script's results living only in a
 * terminal that scrolled away. See test-logs/README.md for the format and
 * why this exists — standing convention as of 2026-08-30, not specific to
 * any one script. `entry` should at minimum carry `dataset`, `layer`,
 * `ac`, `part`, `epic`, `expected`, `actual` (or `null`), and `verdict`. */
export async function logTest(entry) {
  const path = resolve(ROOT, 'test-logs', 'test-log.jsonl');
  await mkdir(resolve(ROOT, 'test-logs'), { recursive: true });
  await appendFile(path, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
}

/** Overwrites the current terminal line — for progress that shouldn't scroll. */
export function progress(msg) {
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K' + msg);
  else process.stdout.write(msg + '\n');
}
