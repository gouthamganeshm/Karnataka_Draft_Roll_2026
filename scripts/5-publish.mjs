#!/usr/bin/env node
/* Stage 5 — put what has been read so far on the site.
 *
 * The ingest was meant to run on GitHub Actions. It cannot: the runner is
 * answered `406 Not Acceptable` by the roll CDN while a desktop in India is
 * served normally (see HANDOFF section 5). So the OCR runs locally and this
 * stage publishes its output — rebuild the buckets straight into `docs/data`,
 * commit them, push. GitHub Pages serves the result with no workflow involved.
 *
 *     node scripts/5-publish.mjs              # build, commit, push
 *     node scripts/5-publish.mjs --no-push    # build and commit only
 *     node scripts/5-publish.mjs --dry-run    # build only, touch nothing in git
 *
 * Safe to run against a half-finished extraction, which is the point: the
 * manifest carries `coverage`, and the client refuses to say "not on the roll"
 * below 99% of booths. A partial publish therefore reports what it has and
 * withholds the verdict it has not earned — it never turns a booth that has not
 * been read into a voter who is not there.
 *
 * Only the JSON is committed. PDFs and the OCR row cache stay out of git, as
 * they always have; `data/` and `cache/` remain ignored.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT, log, readJson } from './lib/common.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noPush = args.includes('--no-push') || dryRun;

// Anything else — `--ac 176`, say — belongs to stage 3, not to us.
const buildArgs = args.filter((a) => a !== '--dry-run' && a !== '--no-push');

const OUT = resolve(ROOT, 'docs', 'data');

const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  return r;
};
const git = (...argv) => run('git', argv);

// ------------------------------------------------------------------- build

/* Built straight into `docs/data` rather than into `data/` and copied, so there
 * is one tree on disk and no chance of publishing a stale copy of it. Stage 3
 * clears its output directory first, so a booth that vanishes from the rows
 * cannot linger in a bucket. */
log(`Building buckets into ${OUT}…\n`);
const build = run(process.execPath, [resolve(ROOT, 'scripts', '3-build-data.mjs'), ...buildArgs], {
  stdio: 'inherit',
  env: { ...process.env, ROLL_DATA: OUT }
});
if (build.status !== 0) {
  log('\nBuild failed — nothing was committed.');
  process.exit(build.status ?? 1);
}

const manifest = await readJson(resolve(OUT, 'manifest.json'));
if (!manifest) {
  log('\nNo manifest was written — refusing to commit a tree that has no index.');
  process.exit(1);
}

const { coverage, electors, partsDone, parts, constituencies } = manifest;
const summary =
  `${electors.toLocaleString('en-IN')} electors, ` +
  `${partsDone.toLocaleString('en-IN')}/${parts.toLocaleString('en-IN')} booths ` +
  `(${coverage.toFixed(1)}%), ${constituencies} ACs`;

log(`\n${summary}`);
if (coverage < 99) {
  log('Below 99% coverage — the site will withhold "not on the roll" verdicts.');
}
if (dryRun) {
  log('\n--dry-run: stopping before git.');
  process.exit(0);
}

// -------------------------------------------------------------------- commit

/* Only ever stage the published tree. The extraction that feeds this is still
 * running in the background and drops scratch files around the repo; a blanket
 * `git add -A` here would sweep them into a data commit. */
git('add', '--', 'docs/data');

if (!git('diff', '--cached', '--quiet').status) {
  log('\nNothing changed since the last publish.');
  process.exit(0);
}

const stat = git('diff', '--cached', '--shortstat').stdout.trim();
const fileCount = git('ls-files', '--', 'docs/data').stdout.trim().split('\n').length;

const message =
  `Publish roll data — ${coverage.toFixed(1)}% of booths read\n\n` +
  `${summary}.\n\n` +
  `Built locally: the roll CDN refuses GitHub's runners with 406 while\n` +
  `serving a desktop in India normally, so the OCR runs here and only the\n` +
  `JSON travels. No PDFs and no row cache are committed.\n\n` +
  `Coverage is ${coverage.toFixed(1)}%, so the client still withholds every\n` +
  `negative verdict — an unread booth reduces confidence rather than\n` +
  `masquerading as a voter who is absent.\n\n` +
  `${fileCount} files, ${stat}.\n\n` +
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n`;

const commit = git('commit', '-m', message);
log(commit.stdout || commit.stderr);
if (commit.status !== 0) process.exit(commit.status ?? 1);

if (noPush) {
  log('--no-push: committed but not pushed.');
  process.exit(0);
}

// ---------------------------------------------------------------------- push

const push = git('push', 'origin', 'HEAD');
log(push.stdout || push.stderr);
if (push.status !== 0) {
  log('Push failed. The commit is local; re-run `git push` when ready.');
  process.exit(push.status ?? 1);
}

log(`\nPublished — ${summary}.`);
