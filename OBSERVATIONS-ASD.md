# Observations — ASD ("uncollectable elector") reports

Session of **2026-08-29**. Written to be picked up cold, without re-deriving
anything. Companion to `HANDOFF.md`; merge into it when convenient.

**Nothing in the extraction or publish pipeline was changed.** No script was
edited, nothing was restarted, and extraction, verification and the publish
loop ran undisturbed throughout. §9 records one change that is *recommended*
but deliberately **not applied** — it is written out in full there so it can be
applied deliberately, later, by a human who wants it.

Everything marked **verified** was actually run this session and its output
inspected. Everything marked **inferred** was reasoned but not tested — the
distinction is load-bearing, per standing rule #2.

---

## 1. What was found

The SIR 2026 **ASD reports** are a second public dataset alongside the draft
roll, one PDF per part, listing every elector whose enumeration form the BLO
could not collect. These are the people who are *absent from the draft roll*,
with the reason recorded against each one.

**verified** — deterministic public path, no CAPTCHA, no cookie, no session,
no required header:

```
https://voters.eci.gov.in/eroll/asd/2026/s10/{ac}/uncollectable_elector_report_ac{ac}_part{part}_KAN.pdf
```

- Kannada only. The `ENG` variant 404s.
- No casing split, unlike the draft-roll path — all lowercase but the `KAN`.
- **Part bounds match the draft roll exactly.** AC 196 serves parts 1–282 and
  cleanly 404s on 283. `cache/manifest.json` already enumerates this dataset,
  so no new discovery stage is needed.

### The decisive property

**These PDFs carry a real text layer and contain zero images.** No OCR, no
Tesseract, no contact sheets, no serial repair. *(verified — `page.get_images()`
empty on every page, `page.get_text()` returns the full table.)*

| | draft roll (OCR) | ASD (text layer) |
|---|---|---|
| throughput | 9 parts/min | **429 parts/min** |
| mean file size | ~9.6 MB | 128 KB |
| EPIC accuracy | ~5.9% flagged | 99.997% strict |
| statewide download | ~571 GB | ~8.0 GB |
| statewide wall clock | ~36 h (68 ACs) | **~3 h (all 224)** |

Row volume: mean **201.5** rows/part, median **120**, range **11–1,110**.
Projected **12.28 M rows statewide** against the roll's 38.5 M electors.
*(verified — 150-part random sample drawn from `cache/manifest.json`,
11 worker processes.)*

The ~3 h figure is padded from a measured ~2.4 h: the sample was a cold single
pass with no retry logic, and a real run needs backoff. **inferred**

---

## 2. Column layout

Ten columns, in order:

| # | Kannada header | Meaning |
|---|---|---|
| 0 | ಕ್ರ.ಸಂ. | serial in this report, contiguous 1..N |
| 1 | ಮತದಾರರ ಗುರುತಿನ ಚೀಟಿ ಸಂಖ್ಯೆ | **EPIC** — wraps 46% of the time, see §4 |
| 2 | ಮತದಾರರ ಹೆಸರು | elector name |
| 3 | ಸಂಬಂಧ | relation type (ತಂದೆ / ಗಂಡ) |
| 4 | ಸಂಬಂಧಿಯ ಹೆಸರು | relative's name |
| 5 | ಹಳೆಯ ಭಾಗದ ಸಂಖ್ಯೆ | **old** part number (pre-SIR roll) |
| 6 | ಹಳೆಯ ಭಾಗದ ಕ್ರಮ ಸಂಖ್ಯೆ | **old** part serial |
| 7 | ವಯಸ್ಸು | age |
| 8 | ಲಿಂಗ | sex (ಪುರುಷ / ಮಹಿಳೆ) |
| 9 | ಗಣತಿ ನಮೂನೆಯನ್ನು ಹಿಂದಿರುಗಿಸದೆ ಇರುವುದಕ್ಕೆ ಕಾರಣ | reason not collected |

Page 1 also carries the AC name and **the booth number and name, as text** —
which is the open item from `HANDOFF.md` §2 (parts currently carry a number and
an empty `partName`), solved from a correct source for every booth that has an
ASD report. **verified**

### Reason codes and statewide mix

| code | Kannada | meaning | share |
|---|---|---|---|
| `SHIFTED` | ಖಾಯಂ ಸ್ಥಳಾಂತರ | permanently shifted | 60.2% |
| `ABSENT` | ಪತ್ತೆಯಾಗಿರುವುದಿಲ್ಲ / ವಾಸ ಸ್ಥಳದಲ್ಲಿ ಇರುವುದಿಲ್ಲ | not traced at residence | 18.8% |
| `DEAD` | ಮರಣ | deceased | 14.6% |
| `DUPLICATE` | ಹೆಸರು ಈಗಾಗಲೇ ನೋಂದಾಯಿಸಲ್ಪಟ್ಟಿದೆ | already registered elsewhere | 6.5% |

Store the **code, not the raw Kannada string** — the string's line-wrapping
varies between files, so the same reason does not compare equal across parts.

---

## 3. Closed doors — do not re-litigate

### The ASD API is CAPTCHA-gated — **blocked**

The portal bundle (`voters.eci.gov.in/static/js/main.76a840cd.js`) exposes
`POST /api/v1/citizen/sir/getAsdData`. It answers unauthenticated and leaks its
DTO field names through a 500, but once those are supplied it returns only:

```json
{"status":"Failed","statusCode":400,"message":"Invalid Catpcha","payload":null}
```

Unlike `generate-published-pdfs` — which merely echoed a CDN path already known
— this endpoint *is* the data. Skipping it is not available. Closed under
standing constraint #1.

### GitHub Actions cannot reach this host — **blocked**

Same host as the draft roll, `voters.eci.gov.in`, which `HANDOFF.md` §5 records
as returning **HTTP 406** to every GitHub-hosted runner flavour — ubuntu and
macOS, `fetch` and `curl` alike, across two unrelated districts.

The ASD path itself was **not** re-tested from a runner (`gh` is unauthenticated
here and the git credential store is off limits). Same host, same edge, so the
same 406 is expected — **inferred**, not verified. One click on
*Actions → Probe roll CDN* settles it.

It no longer matters much: Actions was attractive only because OCR cost 36
hours. At ~3 h locally it would add a scheduling layer to an afternoon's work.

### `getPartByAc` is open but **stale** — do not use it

`GET /api/v1/citizen/sir/getPartByAc?Asmbly={ac}` with a `state: S10` header is
open, no CAPTCHA, and returns booth names in English *and* Kannada
(`partNameV1`). It is tempting for the empty `partName` field.

**It returns 226 parts and Ramanagara booth names for AC 196.** AC 196 is
Hassan, with 282 parts. This is the pre-SIR roll — the identical failure mode as
the CEO mirror in `HANDOFF.md` §2, now confirmed from a second source. A wrong
booth address sends a voter to the wrong ERO counter. **verified**

Take booth names from the ASD PDF's own page-1 header instead.

---

## 4. Extraction — four things that will bite

Each was measured, and each contradicts the obvious implementation.

### 1. Use processes. Never threads.

**PyMuPDF is not thread-safe.** Under a `ThreadPoolExecutor` it silently
returned *corrupt rows from correct bytes* — 9.90% EPIC validity and 72 s per
file. The identical bytes through a `ProcessPoolExecutor`: 100% validity, 15 s.
It does not raise; it just returns wrong data. **verified**

### 2. Do not use `page.find_tables()`

Bin words into cells against the page's own vector rules instead. **36× faster**
(0.14 s vs 5.08 s on a 29-page file) *and* strictly more accurate. Across 299
hand-compared rows the two engines agree on every serial, EPIC, age and sex;
every disagreement is `find_tables` being wrong — it mangles Kannada glyph
clusters (`ಯಶಶ್ವನಿ ಿ` for `ಯಶಶ್ವಿನಿ`) and bleeds stray characters into the
numeric columns. **verified**

Derive rules from `page.get_drawings()`, clustering line and thin-rect items at
~2 pt tolerance; a valid grid has ≥11 vertical rules. Sort each cell's words by
`(round(cy,1), x0)`.

### 3. Join the EPIC column with no separator — it wraps constantly

The EPIC cell is narrower than a 10-character EPIC, so **46% of cells wrap onto
a second line**. Tested over **210 parts / 37,614 rows** across two random
seeds: **verified**

| check | result |
|---|---|
| EPIC cells that wrap | 17,376 of 37,614 (46%) |
| wrapped → valid EPIC grammar | 17,376 / 17,376 |
| wrong join *order* (raw-text witness) | 0 |
| cross-engine disagreement vs `find_tables` | 0 / 37,614 |
| hand-verified against rendered pixels | 23 / 23 |
| fragments per cell | only ever 1 or 2, never 3+ |

Two cases break a naive implementation, both confirmed visually against
rendered crops:

```
['XUL51597',   '02'] -> XUL5159702    # split point VARIES; leading zero survives
['SVF1003771', '1' ] -> SVF10037711   # genuine 11-character EPIC (AC 174)
['YSH505843',  '3' ] -> YSH5058433    # the common case
```

So the join must be **string concatenation, never numeric** (a leading zero is
lost the moment a fragment is parsed as an int), and it must not assume the
break falls before the last character.

### 4. Relax the EPIC grammar — and never use it to repair

AC 174 issues a real **11-character `SVF1…` series**. `EPIC_RE =
[A-Z]{3}[0-9]{7}` must widen to `[A-Z]{3}[0-9]{7,8}` here. **verified**

This is a behaviour change, not a tweak. In the OCR pipeline the grammar is an
*error-correction* tool — it repairs values a camera misread. Extraction here is
exact, so the same coercion would **corrupt correct data**. Validate and flag;
never coerce.

### And one that is not a bug

**A 404 is data.** AC 28 part 224 serves a draft-roll PDF (HTTP 200) but has no
ASD report (HTTP 404, nginx). That booth had no uncollectable electors. Record
it as a *read booth with zero rows*, distinct from a fetch failure, or coverage
will understate. Distinguish a genuine 404 body from a transient edge error and
retry only the latter. **verified**

---

## 5. The two lists are disjoint — measured

AC 176 is fully extracted locally (605/605 parts), giving a complete roll to
test membership against. Of **15,382 ASD rows sampled from 25 of its parts,
exactly 0 appear among its 420,954 draft-roll EPICs.** **verified**

Zero overlap is also what garbage EPICs would produce, so the EPIC space was
checked directly:

- the two sets share prefixes in the same proportions (`YER`: 13,521 ASD
  against 318,009 roll),
- 99.9% of ASD rows carry a prefix present in the roll,
- 100% of ASD `YER` values fall inside the roll's `YER` numeric range.

Same issuing series, zero exact matches. **Being on the ASD list is the
explanation for absence from the roll.** That is what justifies cascading from
one search to the other.

**Incidental, worth knowing:** the OCR'd roll shows **2,432** distinct
three-letter prefixes for AC 176; the text-layer ASD data shows **135**. Most of
that spread is OCR noise, which is a useful independent read on roll quality.

---

## 6. Site integration

### Structure

A second search section on the same page, plus an automatic cascade. The
disjointness result is the argument for the cascade: a roll miss is *exactly*
when the ASD answer is relevant, so making the voter retype their EPIC only
loses people. Wire the existing `notFoundTitle` branch at `docs/app.js:296` to
run the ASD lookup itself and deep-link into the section with the EPIC
pre-filled. The standalone section stays for anyone landing there directly.

### Four verdicts, in order

1. **On the draft roll** — existing card, unchanged.
2. **Not on roll, found in ASD** — show the reason, the **old part number and
   serial**, and the remedy the report itself states: an aggrieved person may
   file a claim with a copy of their Aadhaar, before `claimsCloseAt`.
3. **In neither, both coverages high** — "not found in either list; this may be
   a gap in our extraction", with a link out to the official ECI search. This is
   the correct terminal state and it is honest.
4. **Either coverage below threshold** — withhold, as the roll section already
   does below 99%.

### Data build

Target `docs/data/asd/`, mirroring the existing `docs/data/roll/` hash-bucket
layout so `app.js` reuses its binary search. Buckets stay **arrays**, sorted —
a previous session lost time testing them as objects. Suggested row tuple,
extending the roll's `[suffix, ac, part, serial]`:

```
[suffix, ac, part, serial, reasonCode, oldPart, oldSerial]
```

Add `asdCoverage`, `asdParts`, `asdPartsDone` to the manifest as their **own**
fields. Do **not** fold ASD progress into the existing `coverage` — the 99%
negative-verdict suppression rule would then run against the wrong denominator.

### Two wording cautions

- **An ASD entry is the BLO's assertion, not an adjudicated fact.** "Your BLO
  recorded you as permanently shifted" reads very differently from "you have
  shifted". And 14.6% of these rows say *deceased* — that will sometimes be
  shown to the living person reading it about themselves.
- **Verdict 3 must not read as "you are not a voter."** It means this site
  cannot answer. The wording has to carry that distinction in both languages.

---

## 7. Pre-existing bugs found while reading the site

These are **independent of the ASD work** and affect the live site now.

### 7a. Result cards have no tone colour at all

`docs/app.js:223` emits `result-card tone-${tone}` with tones
`found` / `notfound` / `warn` / `info`. `docs/styles.css:260-263` only ever
defines `.is-deleted` / `.is-clear` / `.is-caution` / `.is-problem`. **Nothing
matches**, so every verdict — found, not found, error — renders identically with
no border colour and no wash. **verified** (`grep -c "tone-" docs/styles.css`
returns 0.)

Four lines fix it, reusing tokens that already exist:

```css
.tone-found    { border-left-color: var(--good);     background: var(--clear-wash); }
.tone-notfound { border-left-color: var(--critical); background: var(--deleted-wash); }
.tone-warn     { border-left-color: var(--warning);  background: var(--caution-wash); }
.tone-info     { border-left-color: var(--muted);    background: var(--problem-wash); }
```

The `.is-*` names look like leftovers from the sibling `karnataka-asddo-dashboard`.

### 7b. An 11-character EPIC cannot be typed into the site

`docs/index.html` sets `maxlength="10"` on `#epic`, and the help text says
"exactly 3 letters followed by 7 digits". `EPIC_RE` in `app.js` matches the
same. The real `SVF1…` series in AC 174 is 11 characters, so those voters
cannot even enter their number. Widening to `{7,8}` / `maxlength="11"` is needed
for the roll search too, not only for ASD. **verified**

### 7c. Unused CSS carried over

`.mode-switch`, `.mode-btn`, `.search-results`, `.sr-reason` and `.acronym` are
styled in `styles.css` but never emitted by `index.html` or `app.js`. The
`.acronym` block with `absent / shifted / death / duplicate / others` dots is
already an ASD-DO legend — **the ASD section can reuse it as-is**, which is
where the mockup's category dots come from. Not a bug; an asset.

---

## 8. Open decisions — not made

- **Names.** The site deliberately indexes only EPIC and serial and says so:
  *"Names, ages and relatives are not held here."* The ASD PDFs hand over exact
  names as text, so they *could* be shown, and it would help someone confirm the
  entry is theirs — but it breaks a stated privacy stance. **Decide before
  building**, because it changes the schema.
- **Scope and order.** ASD is cheap enough to run statewide in one pass rather
  than following the roll's district priority queue.
- **Revision in place.** Sampled PDFs carry `Last-Modified: 2026-08-21`.
  Whether ECI revises ASD reports in place — and so whether the pipeline needs
  re-fetching — is untested. **inferred**
- **Booth names.** The ASD header can fill the empty `partName`, but only for
  booths that *have* an ASD report. Partial backfill or wait: not decided.
- **Name search.** This work keys on EPIC only. Kannada name search
  (normalisation, transliteration, false matches) is deliberately out of scope.

---

## 9. Recommended: rebase before pushing — **not applied**

This is a recommendation only. `scripts/5-publish.mjs` is **unchanged** and
remains byte-identical to what it was before this session.

### The problem

`5-publish.mjs` runs `git push origin HEAD` with no fetch first. That was safe
for as long as this loop was the *only* writer on `main` — there was nothing to
diverge from. That assumption breaks the moment anything else writes to the
branch, and this file is exactly such a thing: it exists to be picked up and
edited later, quite possibly on GitHub directly.

When it does break, it breaks quietly and repeatedly. The remote ends up ahead,
every subsequent push in the loop is rejected non-fast-forward, and because
`6-auto-publish.mjs` treats a failed publish as "retry next cycle", **the loop
keeps running and keeps failing** — publishing silently stops while the log
fills with retries, until a human notices.

### The fix

Insert immediately before the `// ---- push` block's `pushWithTimeout` call:

```js
const pull = git('pull', '--rebase', '--autostash', 'origin', 'main');
if (pull.status !== 0) {
  log(pull.stdout || pull.stderr);
  log('Pull/rebase failed — aborting it and leaving the commit local.');
  git('rebase', '--abort');
  log('Will retry on the next cycle.');
  process.exit(pull.status ?? 1);
}
if (pull.stdout?.trim()) log(pull.stdout.trim());
```

`--autostash` because the extraction running alongside can leave tracked files
dirty mid-cycle, which would otherwise block the rebase outright. `--rebase` so
a data commit never turns into a merge bubble. On failure the rebase is aborted
rather than left half-applied, the push is skipped, and the commit stays local
for the next cycle — which is the script's *existing* failure behaviour, so this
adds no new way to lose work.

### Verified in a throwaway clone, not against this repo

Two clones against a bare remote, with the doc edited in one and a data commit
made in the other:

```
OLD  git push origin HEAD
     ! [rejected]  HEAD -> main (fetch first)

NEW  git pull --rebase --autostash origin main   ->  Successfully rebased
     git push origin HEAD                        ->  5af9f5c..ff291ca  HEAD -> main
```

History stayed linear (`Publish roll data` on top of `edit from github`, no
merge bubble) and the edit made elsewhere survived intact.

### Applying it later is safe

`6-auto-publish.mjs` re-spawns `5-publish.mjs` as a fresh child process every
cycle, so editing the file takes effect on the **next** cycle with no restart
and no interruption to extraction. Run `node --check scripts/5-publish.mjs`
after editing — a syntax error there takes the whole publish loop down.

### Until it is applied

If the remote ever diverges, the loop will stall silently. The manual recovery
is one command, run when no publish is mid-cycle:

```
git pull --rebase --autostash origin main && git push origin HEAD
```

---

## 10. Reproducing the measurements

Every figure above came from throwaway scripts in the session scratchpad,
deliberately kept **out of this repo** while extraction was running:

```
fastparse.py           rule-derived word-binning parser (the recommended approach)
test_wrapped_epic.py   3-way wrapped-EPIC check: grammar, order witness, cross-engine
visual_check.py        renders EPIC cells to PNG for eyeball ground truth
overlap_test.py        ASD vs draft-roll membership, AC 176
bench_asd3.py          throughput benchmark, process pool
sample_statewide.py    unbiased statewide row-count and size projection
```

They are not dependencies — re-derive or discard. The one measurement **not**
reproduced is the GitHub Actions 406 against the ASD path specifically (§3).
