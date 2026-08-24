# Karnataka Draft Electoral Roll 2026 — EPIC search

The Karnataka Chief Electoral Officer publishes the Special Intensive Revision
2026 **draft roll on 24-08-2026**. Claims and objections close **23-09-2026**;
the final roll is published **27-10-2026**.

The draft is published the way electoral rolls are always published: as one PDF
per polling part, several hundred of them per constituency, roughly 58,000
across the state. There is no way to ask "am I on it?" — you have to know your
part number, download the right PDF and read it.

This project turns those PDFs into a static site where a voter types an EPIC
number and gets their entry back. It reformats official data; it is not
official.

Sibling project: [karnataka-asddo-dashboard][asddo], which answers the opposite
question — whether an EPIC is on the **deletion** list. The two are deliberately
separate repos with separate data lifecycles.

[asddo]: https://github.com/gouthamganeshm/karnataka-asddo-dashboard

---

## Where the data comes from

Two publishers serve the same rolls, and only one of them can be crawled.

### The ECI portal — a dead end for bulk access

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
this pipeline for the constituency tree:

| Endpoint | Gives |
|---|---|
| `GET /api/v1/common/districts/S10` | 34 districts, English + Kannada names |
| `GET /api/v1/common/acs/<districtCd>` | that district's ACs: number, name, Kannada name, category |

Both need the `origin`/`referer` pair in `ECI_HEADERS` or they answer `401`.

### The CEO mirror — the actual source

`ceo.karnataka.gov.in` republishes rolls as **direct PDFs with no CAPTCHA**, at
a predictable path. That is how the 2002 roll is served today:

```
https://ceo.karnataka.gov.in/uploads/<DISTRICT>/AC%20<n>/A<ac4><part4>.pdf
                                     BIDAR       AC 1     A0010001.pdf
```

and the full part cascade — every AC and every polling part in the state, 43,398
rows — is a single flat CSV at `ceo.karnataka.gov.in/ac_names.csv`:

```
AC_NO,AC_NAME,PART_NO,PART_NAME_EN
1,Aurad ,1,Government H.P. School Building Chondimukheda
```

**Open question until 24-08-2026:** whether the SIR draft is mirrored here in
the same shape. Everything in `2-extract.mjs` is written against this pattern
because it is the only crawlable one; if the draft lands at a different path the
change is confined to `sourceUrl()` in that file.

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

Note this is **not** true of the ASDDO deletion lists, which do carry a text
layer — that is why the sibling project gets away with a pure text extractor.
Do not assume the two families behave alike.

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

Identical in spirit to the ASDDO dashboard: the data is pre-bucketed by hash so
a static host can answer a query it cannot compute.

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

| Verdict | Condition |
|---|---|
| **On the draft roll** | hash found — shows name, relative, age, gender, AC, part, serial, booth |
| **Not on the draft roll** | not found, and state coverage is ≥ 99% |
| **Can't say yet** | not found, but the constituency has not finished importing |

The third verdict is the important one. A partial import must never let a
missing record read as "you have been left off the roll" — that is a claim that
would send someone to an ERO office for nothing, or worse, reassure someone who
really is missing. Coverage is tracked per constituency in `manifest.json` and
the client refuses to render a negative verdict for an AC that is not complete.

---

## Hosting

The full draft roll is roughly **5.5 crore electors** — about five times the
ASDDO deletion dataset, which already fills 800 MB. GitHub Pages caps a
published site at 1 GB, so the data does not live on Pages.

```
site   →  GitHub Pages / Cloudflare Pages   (docs/, a few hundred KB)
data   →  Cloudflare R2                     (buckets, ~4 GB)
```

R2's free tier is 10 GB of storage with no egress charge for public buckets,
which leaves real headroom. The site is still fully static and fully
client-side; only the bucket origin changes. `scripts/4-upload-r2.mjs` syncs
`data/` to the bucket over the S3 API, and `docs/config.js` holds the public
bucket URL.

---

## Pipeline

| Stage | Script | Does |
|---|---|---|
| 1 | `1-discover.mjs` | District → AC → part tree into `cache/manifest.json`. |
| 2 | `2-extract.mjs` | Streams each part PDF and OCRs it **in memory**, keeping only rows. Resumable. |
| 3 | `3-build-data.mjs` | Rows → hash buckets, per-AC search index, `manifest.json`. |
| 4 | `4-upload-r2.mjs` | Syncs `data/` to the R2 bucket. |

PDF bytes are never written to disk — at ~58,000 parts that would be hundreds of
gigabytes of redundant storage, and the rows are the only part worth keeping.

### Requirements

Node 20+ for the pipeline, and for the OCR stage:

```bash
pip install pymupdf pillow numpy
apt-get install tesseract-ocr          # or: winget install UB-Mannheim.TesseractOCR
```

---

## Status

Draft not yet published (due 24-08-2026). Built and verified so far:

- [x] District and AC discovery — live: **34 districts, 224 constituencies, 43,398 parts**
- [x] CEO mirror URL pattern and the `ac_names.csv` part cascade
- [x] Source triage — ECI portal ruled out, reasons above
- [x] **OCR stage — 100% exact on two states, two resolutions** (see *Measured*)
- [x] Crawl + OCR driver (`2-extract.py`), resumable, multiprocess
- [x] Bucket builder (`3-build-data.mjs`) and R2 sync (`4-upload-r2.mjs`)
- [x] The site (`docs/`) — **proven end to end** on a real constituency
- [ ] CI workflow and the statewide run, once the draft source path is known

### End-to-end proof

Run against Bihar AC 170 (a real, published SIR final roll, in Hindi):

```
45 of 275 booths  →  37,677 rows OCR'd  →  30,521 electors published
                     7,156 rows (19%) withheld as low-confidence
```

Looking up a known EPIC returns its constituency, booth and serial, matching the
source row exactly. Looking up an absent one returns **“Cannot say yet — only
16.4% of the state has been imported”**, not “not on the roll”. That second
behaviour is the one that matters: it is the difference between a tool that is
merely incomplete and one that tells someone they have been struck off when they
have not.
