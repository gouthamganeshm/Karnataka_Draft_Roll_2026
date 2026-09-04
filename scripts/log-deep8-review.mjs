#!/usr/bin/env node
/* One-off: log the 211 manually-reviewed deep8 candidates (8-AC deep
 * confirmation pass, cache/ocr-batching-check-deep8-summary.json) to the
 * test log book, same shape as the 10k pass's
 * ocr-batching-check-manual-review-10k entries. */
import { logTest } from './lib/common.mjs';

const reviewed = (await import('../cache/silent-candidates-deep8-reviewed.json', { with: { type: 'json' } })).default;

for (const r of reviewed) {
  await logTest({
    dataset: 'roll', layer: 'ocr-batching-check-manual-review-deep8',
    ac: r.ac, part: r.part, serial: r.serial,
    expected: r.true_epic,
    actual: { ac: r.ac, part: r.part, serial: r.serial, verdict: r.verdict, true_epic: r.true_epic, batched: r.batched, isolated: r.isolated },
    verdict: r.verdict === 'CONFIRMED' ? 'SILENT_MISMATCH_CONFIRMED' : 'FALSE_POSITIVE_CANDIDATE',
    reason: r.verdict === 'CONFIRMED'
      ? 'pixel-verified genuine misread from the 8-AC deep confirmation pass (per-AC dominant-prefix consensus)'
      : 'pixel-verified: batched/published value already correct, isolated re-OCR was the false lead',
  });
}
console.log(`Logged ${reviewed.length} manual-review verdicts.`);
