# Test log book

A committed, append-only record of every verification test this project runs
against the live site and the source PDFs — one JSON line per test, never
rewritten, never summarized-then-discarded. Explicit user requirement
(2026-08-30): keep this, commit it at regular intervals, and use it for all
testing from here on, not just the exhaustive per-booth sweep that started it.

## Why this exists

Every prior verification script (`7-verify.mjs`, `8-full-sweep.mjs`,
`11-verify-asd.mjs`, `12-full-sweep-asd.mjs`) printed its results to stdout
and then discarded them — a clean pass or fail at the end of a run, but no
durable record of *which* EPICs were checked, when, or what the expected vs.
actual values were. That's fine for "is the site healthy right now" but loses
the ability to answer "was this specific EPIC ever verified, and what did we
see" after the fact, or to notice a slow drift across many runs that no
single run's summary would show.

## Format

`test-log.jsonl` — one JSON object per line, appended only:

```json
{"timestamp":"2026-08-30T13:45:10.975Z","dataset":"asd","layer":"site","ac":115,"part":209,"epic":"IOP3324431","expected":{"ac":115,"part":209,"serial":90,"reasonCode":"SHIFTED","oldPart":197,"oldSerial":500},"actual":[["f025d52a",115,209,90,"SHIFTED",197,500,"ಗುರುರಾಜ ಹೆಚ್.","ಸಿದ್ದಲಿಂಗಪ್ಪ"]],"verdict":"pass"}
```

Fields:

| Field | Meaning |
|---|---|
| `timestamp` | ISO-8601, when the test ran |
| `dataset` | `roll` or `asd` |
| `layer` | `site` (live-site consistency) or `pdf` (source-PDF re-verification) |
| `ac`, `part` | which booth |
| `epic` | which EPIC was checked |
| `expected` | what `cache/rows` / `cache/asd-rows` said should be true |
| `actual` | what the live site (or the re-parsed PDF) actually returned |
| `verdict` | `pass` or `fail` |
| `reason` | (fail only) why |

Never rewritten in place, never truncated. If a log grows large enough to be
unwieldy, roll it into a dated file (`test-log-2026-08.jsonl`) rather than
deleting history — this is a record, not a cache.

## Committing it

Committed at regular intervals while a long-running sweep is active, not
just once at the end — see `scripts/16-commit-test-log.mjs`, a small
supervisor loop that watches this directory and commits+pushes on a cadence,
the same shape as `6-auto-publish.mjs` but for this log instead of the roll
data. Run it alongside any exhaustive sweep so a crash never loses more than
one interval's worth of results.

## Which scripts write here

- `scripts/14-exhaustive-sweep.mjs` — the exhaustive per-booth sweep this
  log book was built for.
- `scripts/7-verify.mjs`, `8-full-sweep.mjs`, `11-verify-asd.mjs`,
  `12-full-sweep-asd.mjs` — the existing per-AC and per-AC-sample sweeps,
  updated to log here too, so this is the one place to look for "has this
  EPIC ever been checked", regardless of which script checked it.
