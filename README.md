# Karnataka Draft Electoral Roll 2026 — EPIC search

The Karnataka Chief Electoral Officer published the Special Intensive Revision
2026 **draft roll on 24-08-2026**. Claims and objections close **23-09-2026**;
the final roll is due **27-10-2026**.

The draft is published the way electoral rolls are always published: as one PDF
per polling part, several hundred of them per constituency, **60,923 of them
across the state**. There is no way to ask "am I on it?" — you have to know
your part number, download the right PDF and read it.

This project turns those PDFs into a static site where a voter types an EPIC
number and gets their entry back. It reformats official data; it is not
official. As of 30-08-2026 the draft roll is fully imported: **224/224
constituencies, 100% of booths, ~44.4M electors**.

It also indexes a second, separate ECI dataset — see
[**The ASD list — a second, separate search**](#the-asd-list--a-second-separate-search)
below — and checks both on every search.

---

## Where the data comes from

### The ECI portal's own form — a dead end for bulk access

`voters.eci.gov.in/download-eroll?stateCode=S10` is the official download page,
and the CEO's own "Electoral Roll 2025/2026" menu item redirects to it. It
cannot be used as a bulk source, for two independent reasons found by reading
the portal's own bundle (`/static/js/main.*.js`):

- **Every PDF download is CAPTCHA-gated.** `POST /api/v1/printing-publish/generate-published-pdfs`
  is reached only after the image CAPTCHA on the form is solved. This project
  does not attempt to defeat that, and should not.
- **Request parameters are encrypted.** Query endpoints carry `accept_yek` and
  `accept_rotcev` headers — "key" and "vector" spelled backwards — and the
  bodies are ciphertext, which is why a plain JSON payload gets a bare `400`.

Two endpoints on the same gateway *are* open, take plain GETs, and are used by
this pipeline for the district/constituency tree:

| Endpoint | Gives |
|---|---|
| `GET https://gateway-voters.eci.gov.in/api/v1/common/districts/S10` | 34 districts, English + Kannada names |
| `GET https://gateway-voters.eci.gov.in/api/v1/common/acs/<districtCd>` | that district's ACs: number, name, Kannada name, category |

Both need the `origin`/`referer` pair in `ECI_HEADERS` or they answer `401`.

### ECI's own CDN — the actual source, no CAPTCHA, publicly reachable

The CEO's `ceo.karnataka.gov.in` mirror (used for the 2002 roll, at
`/uploads/<DISTRICT>/AC%20<n>/A<ac4><part4>.pdf`) turned out **not** to carry
the SIR draft — its part cascade CSV (`ac_names.csv`) is stale: 43,398 parts
statewide against the draft's 60,923, and it's missing whole booths (AC 196
part 227 isn't in it at all despite being real). It is not used by this
pipeline; do not fall back to it.

The actual source is **ECI's own CDN**, and every published part PDF sits at a
predictable, unauthenticated, no-CAPTCHA path:

```
https://voters.eci.gov.in/eroll/2026/s10/sir-draftroll/<ac>/2026-EROLLGEN-S10-<ac>-SIR-DraftRoll-Revision1-KAN-<part>-WI.pdf
                                                        150                    150                                1   227
```

- `<ac>` — the assembly constituency number (repeated once as a path segment,
  once in the filename).
- `Revision1` — the only revision ECI has published so far (`Revision0` and
  `Revision2` both 404 as of 2026-08-25). Hardcoded in `partUrl()` in both
  `scripts/1-discover.mjs` and `source_url()` in `scripts/2-extract.py`; if ECI
  ever ships a `Revision2` this needs updating in both places, or lookups will
  silently serve the stale revision instead of erroring (see `HANDOFF.md` §9).
- `KAN` — Kannada. ENG is published too at the same path with `ENG` swapped
  in, but OCR only needs the EPIC and serial (both ASCII in either language),
  so KAN is a canonical-source choice, not an accuracy one.
- `<part>` — the polling part number. There is no API that lists how many
  parts a constituency has; `1-discover.mjs` finds `N` with a binary-search
  probe (about a dozen `HEAD`/`GET` requests per AC) since parts are confirmed
  to run contiguously `1..N` with no gaps.

No API and no CAPTCHA gate this path — a plain `GET` returns the PDF directly,
confirmed via both `fetch` and `curl` from a residential/India-based IP. It is
**not** reachable from GitHub Actions hosted runners regardless of OS flavor
(`406 Not Acceptable` from every one tried — see `HANDOFF.md` §5), which is why
extraction runs locally rather than in CI.

---

## The rolls have no text in them

This is the fact the whole project is shaped around.

**Every electoral roll PDF ECI publishes is a stack of full-page JPEGs.** No
text layer, no embedded fonts, no `/ToUnicode`. Confirmed on two files from two
states — `PyMuPDF.get_text()` returns **0 characters across every page**:

| File | Pages | Render | Text chars |
|---|---|---|---|
| `2026-FC-BY-EROLLGEN-S10-24-FinalRoll-Revision2-ENG-4-WI.pdf` | 25 | 1652×2338 | 0 |
| `2026-EROLLGEN-S15-41-SIR-DraftRoll-Revision1-ENG-1-WI.pdf` | 16 | 1983×2806 | 0 |

So there is nothing to extract. The rows have to be **OCR'd**, and
`scripts/ocr/roll_ocr.py` does that.

Note this is **not** true of the ASD list (see below), which does carry a
text layer — a pure table extractor works there, and would be the wrong tool
here. Do not assume the two families behave alike.

### Why it is nonetheless tractable

These are not photographs of paper. They are crisp digital rasterisations of a
rigid template, so the structure is recoverable exactly *before* any OCR runs:

```
page  →  10 card bands × 3 columns  =  30 elector cards
card  →  a ruled serial box (top left) and an EPIC (top right)
```

Every boundary is measured from the page's own ink rather than hard-coded —
which is load-bearing, since the two states above render at different
resolutions and both parse with the same code.

### Accuracy comes in three layers

1. **Geometry.** Crops are cut to detected rules, then trimmed to ink, so
   Tesseract never sees a box border. It reads borders as `1` or `I`.
2. **Grammar.** An EPIC is exactly `[A-Z]{3}[0-9]{7}`, so every confusable glyph
   has one legal reading once you know which side of the letter/digit boundary
   it falls on. An 11-character reading is a spurious glyph at that boundary
   (`TDB0917013` → `TDBO0917013`), so the first three and last seven survive.
3. **Sequence.** Serials run consecutively, so a page's readings are fitted to
   that run. The offset `serial[i] - i` is modelled as *piecewise* constant, not
   constant: a struck-off name leaves a real gap and shifts everything after it.
   A single global anchor put a whole Meghalaya part one out and flagged 40% of
   its rows; a rolling mode tracks the steps instead of averaging across them.

A row that fails all three is returned with `ok=False`. It must be counted as
**unread, never as absent** — see the coverage guard.

#### The serial boxes get a second look

Every serial failure measured on the Karnataka draft came from the *contact
sheet*, not the crops. Cut and enlarged, the boxes are unambiguous — but read 30
to a sheet at `--psm 6` with no whitelist, Tesseract turns a crisp `51` into
`31`, `500` into `200`, `52` into `32`. A systematic `5`, and a `7` that lands as
punctuation.

So a serial that disagrees with the fitted sequence is re-cut and read on its
own as a single word restricted to digits (`--psm 8`, digit whitelist — safe
here, unlike the EPIC pass, because the field really is digits-only). The
corrected readings go back in and the sequence is fitted **again**, so a
recovered box also strengthens the vote for its neighbours.

| | flagged, one pass | flagged, two passes |
|---|---|---|
| AC 196 part 227 (792 cards) | 10.4% | **5.9%** |
| AC 177 parts 1–3 (1,614 cards) | 7.0% | **3.7%** |

The cost is ~170 ms per re-read on the ~10% of boxes that need one. Note what
the second pass does *not* do: across 792 cards it changed the fitted serial
exactly once. It is almost entirely confirming values the sequence already had
right — those rows were being withheld while carrying a correct serial *and* a
perfectly read EPIC.

Counter-intuitively, enlarging harder makes it worse: padding to 24 px with a
140 px target recovered 6 of 82 where 16 px and 90 px recovered 34. These glyphs
are already near the size Tesseract wants.

### Measured

`python scripts/ocr/test_roll_ocr.py <ka.pdf> <ml.pdf>` checks a page from each
state against hand-transcribed ground truth:

| | cards | EPIC exact | serial exact | wrong but confident |
|---|---|---|---|---|
| Karnataka AC24 part 4 | 30/30 | **30/30** | **30/30** | 0 |
| Meghalaya AC41 part 1 | 30/30 | **30/30** | **30/30** | 0 |

Whole parts, end to end:

| | rows | EPICs well-formed | unique | serials | low-confidence | time |
|---|---|---|---|---|---|---|
| Karnataka AC24 part 4 | 575 | 100% | 575 | 1–575, no gaps | 15 (2.6%) | 34 s |
| Meghalaya AC41 part 1 | 345 | 100% | 345 | 1–346, one real gap | 13 (3.8%) | 32 s |

**Cost at state scale:** ~58,000 parts × ~33 s ≈ 530 core-hours, so roughly a
day and a half on 16 cores. Batching matters more than it looks: Tesseract
process startup dominates at this crop size, so OCR-ing one contact sheet of 30
cards takes 0.9 s where 30 separate calls take 9.6 s.

### Resolution is the thing that actually matters

Publishers render at different sizes, and accuracy tracks that almost entirely:

| State | Render | ≈ DPI | EPICs well-formed |
|---|---|---|---|
| Meghalaya | 1983×2806 | ~240 | 100% |
| Karnataka | 1652×2338 | ~200 | 100% |
| Bihar | 949×1343 | ~115 | 88–93% |

Every offset in `card_header` is therefore a fraction of `REFERENCE_WIDTH`
rather than a pixel count. That is not tidiness — a hard-coded 52-pixel header
strip that fits the top two rows runs straight through the elector's name on
Bihar's, and read **3 rows out of a 44-page part** instead of ~1,300.

`ROLL_OCR_RETRY=1` adds a second pass that re-reads failed EPICs individually.
It is **off by default** because it is a bad trade as measured: on a Bihar part
it doubled runtime (44 s → 113 s) to move well-formed rows from 88% to 90%.
Rows it does not recover are flagged, not published, so skipping it costs
coverage rather than correctness — and Karnataka renders at 200 DPI, where the
first pass already reads everything.

Only the serial and the EPIC are read. They answer the question the site exists
to answer, they are the two fields with a grammar strict enough to *validate*
rather than trust, and they are ~5× cheaper than reading the whole card.

---

## How a lookup works without a server

The data is pre-bucketed by hash so a static host can answer a query it
cannot compute — the same mechanism serves both the roll and the ASD lookup
below, against two separate bucket trees.

```
user types ABC1234567
   → SHA-256 in the browser
   → first N hex chars pick a bucket:  roll/ab/cd.json   (one small file)
   → the next 8 hex chars are matched against records inside it
```

**The EPIC never leaves the device.** No request contains it — only a request
for a bucket shared by thousands of numbers. That is strictly better for the
person checking than a server-backed lookup, which necessarily sees both the
EPIC and the IP.

The buckets contain no EPIC numbers, only hashes. The browser already knows the
number the user typed, so it can render it. This is obscurity rather than
secrecy — the EPIC keyspace is small enough to brute force — but it stops the
published data being trivially scraped into an EPIC-to-name table.

### The verdicts

Every search runs **two independent lookups** — the draft roll and the ASD
list below — and never short-circuits on the first hit, because the two are
not guaranteed to be mutually exclusive (see the next section):

| Verdict | Condition |
|---|---|
| **On the draft roll** | roll hash found, ASD hash not found |
| **Found on the ASD list** | roll hash not found, ASD hash found — shows the BLO's stated reason and the claim remedy |
| **Found on both — they disagree** | both found — shown side by side, neither treated as authoritative |
| **Not found on either** | neither found, and both imports are ≥ 99% complete |
| **Can't say yet** | neither found, but either import has not finished |

The last verdict is the important one. A partial import must never let a
missing record read as "you have been left off the roll" — that is a claim that
would send someone to an ERO office for nothing, or worse, reassure someone who
really is missing. Coverage is tracked per constituency in each dataset's own
`manifest.json`, independently, and the client refuses to render a negative
verdict while either import is incomplete.

---

## The ASD list — a second, separate search

Alongside the draft roll, ECI separately publishes an **ASD ("uncollectable
elector") report** — one PDF per polling part, listing every elector whose
enumeration form the Booth Level Officer could not collect, with the reason
recorded against each one. These are, by definition, people who are largely
*absent* from the draft roll — so a roll search alone leaves them with no
answer at all. This site checks both lists on every search rather than making
someone guess which one applies to them.

```
https://voters.eci.gov.in/eroll/asd/2026/s10/<ac>/uncollectable_elector_report_ac<ac>_part<part>_KAN.pdf
```

Unlike the draft roll, **these PDFs carry a real text layer** — no OCR needed,
just careful table extraction (`scripts/ocr/asd_parser.py`, rule-derived cell
binning against the page's own vector rules, never PyMuPDF's `find_tables()` —
see that module's own header comment for the full list of hard-won lessons).
Extraction ran the whole state in 85 minutes: **10,766,778 rows, 100% coverage,
0 unreadable parts.**

The two lists are stored, and served, as **fully separate trees** —
`docs/data-asd/` is a *sibling* of `docs/data/`, not a child of it, with its
own `manifest.json` and its own coverage figures that are never folded into
the roll's. That separation is deliberate at every layer (raw rows, published
buckets, coverage accounting) and is a real, load-bearing constraint, not
tidiness: `3-build-data.mjs`'s full-rebuild path deletes the whole `docs/data`
tree, and a `docs/data/asd` *child* directory would have been silently wiped
out by that the next time it ran.

**Unlike the roll index, ASD records carry a name** (and a relative's name) —
a deliberate exception to this site's usual "EPIC and serial only" stance,
made because it helps confirm an entry is really the searcher's own. An ASD
entry is the Booth Level Officer's own recorded assertion, not an adjudicated
fact, and the UI says so next to every ASD result.

### Pipeline

| Stage | Script | Does |
|---|---|---|
| 9 | `9-extract-asd.py` | Process-pool fetch + parse, resumable. A 404 is a valid zero-row read (that booth had no uncollectable electors), not a failure. |
| 10 | `10-build-asd-data.mjs` | Rows → hash buckets (same layout as the roll's), `docs/data-asd/manifest.json`. Full rebuild only — the dataset is small enough not to need stage 3's incremental-checkpoint machinery. |
| 11 | `11-verify-asd.mjs` | Per-AC spot check: live-site consistency + a re-fetch/re-parse of the source PDF. |
| 12 | `12-full-sweep-asd.mjs` | Statewide sweep (one booth, one sample, every constituency) plus corner cases: reason-code mix, names actually published, duplicate EPICs, a sampled cross-check against the roll. |

---

## Hosting

Both trees are served **directly from GitHub Pages** — `docs/data/` (roll,
~1.2 GB) and `docs/data-asd/` (ASD, ~1.3 GB), pushed straight from the
machine doing the OCR since the source CDN is unreachable from a hosted CI
runner (see below). That is well past GitHub Pages' documented ~1 GB
guideline for a site's total content, and it has kept working regardless —
noted here as a real, currently-accepted risk rather than a hard limit that
was actually hit. `scripts/4-upload-r2.mjs` exists as a ready fallback to
Cloudflare R2 (10 GB free tier, no egress charge on public buckets) if GitHub
ever does enforce it; `docs/config.js` already externalizes both `DATA_BASE`
and `ASD_DATA_BASE` for exactly that switch.

---

## Pipeline

| Stage | Script | Does |
|---|---|---|
| 1 | `1-discover.mjs` | District → AC → part tree into `cache/manifest.json`. |
| 2 | `2-extract.py` (`2-extract-forever.mjs` supervisor) | Streams each part PDF and OCRs it **in memory**, keeping only rows. Resumable. |
| 3 | `3-build-data.mjs` | Rows → hash buckets, per-AC search index, `manifest.json`. Incremental after the first run. |
| 4 | `4-upload-r2.mjs` | Syncs `docs/data/` to Cloudflare R2 — written and ready, **not currently used**; the site serves straight from GitHub Pages instead (see *Hosting*). |
| 5–6 | `5-publish.mjs` (`6-auto-publish.mjs` loop) | Build → commit → push, on a cadence, while extraction runs. |
| 7–8 | `7-verify.mjs`, `8-full-sweep.mjs` | Per-AC spot check and a full statewide sweep, both against the *live* site and a fresh re-fetch of the source PDF — never trusting the pipeline's own prior output. |
| 9–12 | ASD stages | See *The ASD list* above. |

PDF bytes are never written to disk — at 60,923 parts that would be hundreds of
gigabytes of redundant storage, and the rows are the only part worth keeping.

### Requirements

Node 20+ for the pipeline, and for the OCR stage:

```bash
pip install pymupdf pillow numpy
apt-get install tesseract-ocr          # or: winget install UB-Mannheim.TesseractOCR
```

---

## Status

**Live and complete.** Both datasets fully imported and verified:

- [x] Draft roll — **224/224 constituencies, 60,923/60,923 booths, 100%**,
      ~44.4M electors, 0 unreadable parts
- [x] ASD list — **224/224 constituencies, 100%**, 10,766,778 rows, 0
      unreadable parts (85 minutes statewide, text-layer extraction)
- [x] Cross-checked against the CEO's own 28-08-2026 press note: 99.4%
      overall, every district in a 97.6%–99.8% band — the site's district
      table shows this comparison live, with the gap explained in place
- [x] The five-verdict search, both lists, one box — live
- [x] Statewide sweep tests for both datasets, live-site + source-PDF
      cross-checks, corner cases (approximate serials, withheld rows,
      duplicate EPICs, boundary constituencies) — `8-full-sweep.mjs` /
      `12-full-sweep-asd.mjs`
- [ ] Full statewide duplicate/overlap audit across all 224 ACs (a sampled
      version already runs inside the ASD sweep; the exhaustive pass is
      still queued — see `HANDOFF.md`)
- [ ] Root cause of the residual ~0.6% gap against the CEO's official count
      — investigation queued, with an explicit constraint that any fix
      re-pulls only the specific affected booths, never a full rebuild

See `HANDOFF.md` for the full session-by-session history, and
`OBSERVATIONS-ASD.md` for the ASD dataset's original design derivation.
