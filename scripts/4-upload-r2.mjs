/* Stage 4 — publish `data/` to Cloudflare R2.
 *
 * The site is a few hundred KB and lives on Pages; the data is gigabytes and
 * lives here, because GitHub Pages caps a published site at 1 GB and the full
 * draft roll is several times that. R2's free tier is 10 GB with no egress
 * charge on a public bucket.
 *
 * Talks to R2's S3-compatible API directly with SigV4 signed by node:crypto —
 * no SDK. That is not purity: the AWS SDK is a ~20 MB dependency tree for four
 * HTTP verbs, and this has to still run years from now.
 *
 *   R2_ACCOUNT_ID=...  R2_BUCKET=...  R2_ACCESS_KEY_ID=...  R2_SECRET_ACCESS_KEY=... \
 *     node scripts/4-upload-r2.mjs
 *
 *   --dry-run    list what would change, upload nothing
 *   --force      re-upload everything, ignoring the remote ETag
 *
 * Only changed files are sent. A rebuild rewrites every bucket file but most
 * are byte-identical, and re-uploading 60,000 unchanged objects on every import
 * is slow enough to discourage running imports.
 */

import { createHash, createHmac } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { DATA, fmtBytes, log, pool, progress } from './lib/common.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const concurrency = Number(args[args.indexOf('--concurrency') + 1]) || 16;

const ACCOUNT = process.env.R2_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET;
const KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET = process.env.R2_SECRET_ACCESS_KEY;

if (!ACCOUNT || !BUCKET || !KEY_ID || !SECRET) {
  log('Set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
  process.exit(1);
}

const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;
const REGION = 'auto';
const SERVICE = 's3';

// ------------------------------------------------------------ SigV4

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

function signedHeaders(method, key, body, extra = {}) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? '');

  const headers = {
    host: HOST,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...extra
  };
  const sortedNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = sortedNames
    .map((h) => `${h}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === h)]).trim()}\n`)
    .join('');
  const signedHeaderList = sortedNames.join(';');

  // Each path segment is escaped, but the separators are not.
  const canonicalUri = `/${BUCKET}/${key}`.split('/').map(encodeURIComponent).join('/')
    .replace(/%2F/g, '/');
  const canonicalRequest = [
    method, canonicalUri, '', canonicalHeaders, signedHeaderList, payloadHash
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)
  ].join('\n');

  let signing = hmac(`AWS4${SECRET}`, dateStamp);
  for (const part of [REGION, SERVICE, 'aws4_request']) signing = hmac(signing, part);
  const signature = createHmac('sha256', signing).update(stringToSign).digest('hex');

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${KEY_ID}/${scope}, ` +
    `SignedHeaders=${signedHeaderList}, Signature=${signature}`;
  return { headers, url: `https://${HOST}${canonicalUri}` };
}

async function send(method, key, body, extra) {
  const { headers, url } = signedHeaders(method, key, body, extra);
  return fetch(url, { method, headers, body });
}

// ------------------------------------------------------------ walk

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

const contentType = (key) =>
  key.endsWith('.json') ? 'application/json'
    : key.endsWith('.bin') ? 'application/octet-stream'
      : 'text/plain';

// ------------------------------------------------------------ run

try {
  await stat(DATA);
} catch {
  log(`${DATA} does not exist. Run \`npm run build\` first.`);
  process.exit(1);
}

log(`Scanning ${DATA}…`);
const keys = await walk(DATA);
log(`${keys.length} files`);

let uploaded = 0;
let skipped = 0;
let failed = 0;
let bytes = 0;

await pool(keys, concurrency, async (key) => {
  const body = await readFile(resolve(DATA, key));
  const digest = createHash('md5').update(body).digest('hex');

  if (!force) {
    // R2 returns the MD5 as the ETag for a single-part upload, so an unchanged
    // file can be recognised without downloading it.
    const head = await send('HEAD', key).catch(() => null);
    if (head?.ok && head.headers.get('etag')?.replace(/"/g, '') === digest) {
      skipped++;
      return;
    }
  }

  if (dryRun) {
    uploaded++;
    bytes += body.length;
    return;
  }

  const res = await send('PUT', key, body, { 'content-type': contentType(key) });
  if (!res.ok) {
    failed++;
    if (failed <= 5) log(`\n  ${key}: HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
    return;
  }
  uploaded++;
  bytes += body.length;
}, (done, total) => progress(`  ${done}/${total}  up ${uploaded}  same ${skipped}  failed ${failed}`));
progress('');

log(`\n${dryRun ? 'Would upload' : 'Uploaded'} ${uploaded} files (${fmtBytes(bytes)}), ${skipped} unchanged, ${failed} failed`);
if (failed) process.exit(1);
log(`\nPoint docs/config.js DATA_BASE at the bucket's public URL.`);
