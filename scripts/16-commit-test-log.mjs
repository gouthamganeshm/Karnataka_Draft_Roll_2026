#!/usr/bin/env node
/* Stage 16 — keep test-logs/ committed while a long sweep runs unattended.
 *
 * `14-exhaustive-sweep.mjs` (and, going forward, every verify/sweep script —
 * see test-logs/README.md) appends to test-logs/test-log.jsonl as it runs,
 * sometimes for days. This watches that file and commits+pushes on an
 * interval, the same shape as `6-auto-publish.mjs` but for the log book
 * instead of the roll data — so a crash mid-sweep loses at most one
 * interval's worth of results, not the whole run's.
 *
 *     node scripts/16-commit-test-log.mjs                  # every 10 minutes
 *     node scripts/16-commit-test-log.mjs --interval 300    # every 5 minutes
 *     node scripts/16-commit-test-log.mjs --once             # single check, no loop
 *
 * Does not touch docs/data or docs/data-asd — only test-logs/. If a git
 * commit/push fails (e.g. the roll's own auto-publish loop holds the index
 * lock at that instant), it is logged and retried next interval rather than
 * treated as fatal — the same "retry next cycle" philosophy 6-auto-publish.mjs
 * already uses.
 */

import { spawnSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CACHE, ROOT, log } from './lib/common.mjs';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const intervalMs = Number(argValue('--interval') ?? 600) * 1000;
const once = args.includes('--once');

const RUN_LOG = resolve(CACHE, 'commit-test-log.log');

async function record(line) {
  const stamp = new Date().toISOString();
  await appendFile(RUN_LOG, `${stamp}  ${line}\n`).catch(() => {});
}

function git(...cmdArgs) {
  return spawnSync('git', cmdArgs, { cwd: ROOT, encoding: 'utf8' });
}

async function commitIfChanged() {
  const status = git('status', '--porcelain', '--', 'test-logs');
  if (status.status !== 0) {
    await record(`git status failed: ${status.stderr?.trim()}`);
    return;
  }
  if (!status.stdout.trim()) return; // nothing new

  const lines = status.stdout.trim().split('\n').length;
  const add = git('add', '--', 'test-logs');
  if (add.status !== 0) {
    await record(`git add failed: ${add.stderr?.trim()}`);
    return;
  }

  // Counted in Node rather than shelling out to `wc` — this project avoids
  // OS-specific binaries elsewhere (see lib/common.mjs's own header comment)
  // and spawnSync with shell:true on an unescaped path is a real footgun,
  // not just a deprecation warning.
  let totalLines = '?';
  try {
    const text = await readFile(resolve(ROOT, 'test-logs', 'test-log.jsonl'), 'utf8');
    totalLines = String(text.split('\n').filter((l) => l.trim()).length);
  } catch { /* leave as '?' */ }

  const commit = git('commit', '-m', `Test log: ${totalLines} entries as of ${new Date().toISOString()}`);
  if (commit.status !== 0) {
    // Nothing staged (race with a manual commit elsewhere) is not an error.
    if (/nothing to commit/.test(commit.stdout ?? '')) return;
    await record(`git commit failed: ${commit.stderr?.trim() || commit.stdout?.trim()}`);
    return;
  }

  const push = git('push', 'origin', 'HEAD');
  if (push.status !== 0) {
    await record(`git push failed (commit made locally, will retry push next cycle if needed): ${push.stderr?.trim()}`);
    return;
  }

  await record(`committed + pushed — ${lines} changed file(s), ${totalLines} total log entries`);
  log(`[commit-test-log] committed + pushed — ${totalLines} total log entries`);
}

async function main() {
  await commitIfChanged();
  if (once) return;
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    await commitIfChanged();
  }
}

await main();
