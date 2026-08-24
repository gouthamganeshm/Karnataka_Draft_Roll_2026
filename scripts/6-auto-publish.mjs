#!/usr/bin/env node
/* Stage 6 — keep the site caught up to the OCR without a human in the loop.
 *
 * `2-extract.py` runs for hours unattended, appending to `cache/done/<ac>.txt`
 * as each part finishes. This watches that count and calls `5-publish.mjs`
 * whenever it has grown, so newly-read booths reach the site on their own.
 *
 * Not per-part. A full publish rebuilds every hash bucket from scratch — that
 * is how stage 3 guarantees a booth that turns out unreadable cannot linger in
 * a stale bucket — and at the current row count that rebuild alone measures
 * ~47s, before the commit and push. Firing it once per part (~7s apart at the
 * OCR's measured 9 parts/min) would mean each publish starts before the last
 * one finished, competing with the OCR pool for the same CPU. Polling on an
 * interval instead means the newest published state is always at most one
 * interval stale — a few minutes, not immediate, but unattended either way.
 *
 *     node scripts/6-auto-publish.mjs                  # every 3 minutes
 *     node scripts/6-auto-publish.mjs --interval 300   # every 5 minutes
 *     node scripts/6-auto-publish.mjs --once            # single check, no loop
 *
 * Runs until killed. Every publish is logged to `cache/publish.log` with a
 * timestamp, so a run left overnight has a record of what shipped when.
 */

import { spawnSync } from 'node:child_process';
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CACHE, ROOT, log } from './lib/common.mjs';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const intervalMs = Number(argValue('--interval') ?? 180) * 1000;
const once = args.includes('--once');

const DONE = resolve(CACHE, 'done');
const LOG = resolve(CACHE, 'publish.log');

async function doneCount() {
  let files;
  try {
    files = await readdir(DONE);
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of files) {
    const text = await readFile(resolve(DONE, f), 'utf8').catch(() => '');
    n += text.split('\n').filter((l) => l.trim()).length;
  }
  return n;
}

async function record(line) {
  const stamp = new Date().toISOString();
  await appendFile(LOG, `${stamp}  ${line}\n`).catch(() => {});
}

function publish() {
  const r = spawnSync(process.execPath, [resolve(ROOT, 'scripts', '5-publish.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit'
  });
  return r.status === 0;
}

let lastPublished = -1; // force one publish on startup if anything is done

log(`Watching ${DONE} every ${intervalMs / 1000}s — Ctrl+C to stop.\n`);

for (;;) {
  const n = await doneCount();
  if (n > lastPublished) {
    log(`\n[${new Date().toLocaleTimeString()}] ${n} parts done (was ${lastPublished < 0 ? 0 : lastPublished}) — publishing…`);
    const ok = publish();
    await record(ok ? `published at ${n} parts done` : `publish FAILED at ${n} parts done`);
    if (ok) lastPublished = n;
    else log('Publish failed — will retry next cycle without losing progress.');
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, intervalMs));
}
