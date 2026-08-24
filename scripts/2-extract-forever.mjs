#!/usr/bin/env node
/* Supervisor for stage 2 — keep OCR running across a growing scope.
 *
 * `2-extract.py` is one-shot: it reads `cache/manifest.json` once at startup,
 * builds its job list, works through it, and exits. That is fine for a fixed
 * scope, but the manifest is now meant to grow — `1-discover.mjs --district
 * <new codes>` appends the next priority batch onto the end of it (see that
 * file's header) — and nothing re-reads it once the running process has
 * already loaded an older, shorter list.
 *
 * This restarts `2-extract.py` every time it exits, so a batch finishing
 * always leads straight into checking the manifest again rather than the
 * pipeline silently going idle until someone notices and re-runs it by hand.
 * `2-extract.py`'s own resumability (`cache/done/<ac>.txt`) means a restart
 * costs at most the one part that was mid-flight — never a re-read.
 *
 *     node scripts/2-extract-forever.mjs
 *     node scripts/2-extract-forever.mjs --workers 8
 *
 * Stops on its own once a restart finds nothing left to do — i.e. every part
 * in the current manifest is done. Growing the manifest again (another
 * `1-discover.mjs --district ...` run) needs a fresh invocation of this
 * supervisor; it does not poll for scope that does not exist yet.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT, log } from './lib/common.mjs';

const extraArgs = process.argv.slice(2);

let round = 0;
for (;;) {
  round++;
  log(`\n=== extract round ${round} — ${new Date().toLocaleTimeString()} ===`);
  const r = spawnSync('python', [resolve(ROOT, 'scripts', '2-extract.py'), ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    // Unbuffered: stdout is being redirected to a log file, not a TTY, so
    // Python block-buffers by default and progress lines sit unflushed for
    // minutes at a time — the run is fine either way (done-markers are
    // fsync'd straight to disk regardless), but a multi-hour run with no
    // visible progress looks indistinguishable from a hang.
    env: { ...process.env, PYTHONIOENCODING: 'utf8', PYTHONUNBUFFERED: '1' }
  });

  if (r.status !== 0) {
    // A crashed round is not the same as a finished one — back off briefly
    // and try again rather than spinning, but do not give up on the queue.
    log(`\nround ${round} exited ${r.status} — retrying in 30s`);
    await new Promise((res) => setTimeout(res, 30000));
    continue;
  }

  // 2-extract.py itself prints this when its job list came back empty; that
  // is the one condition that means stop rather than restart.
  break;
}

log('\nNothing left in the current manifest. Supervisor exiting — run '
  + '`node scripts/1-discover.mjs --district <codes>` to queue more, then '
  + 'restart this supervisor.');
