# Handoff — Karnataka SIR 2026 draft roll

State of the work as of **2026-08-24**, written so a cold session can pick it up
without re-deriving anything. Everything marked *verified* was actually run and
its output inspected; everything else says what it is.

---

## 1. What this project is

An open-source **static** site that lets a voter check whether their EPIC number
appears in the Karnataka **SIR 2026 Draft Roll (Revision 1)**. Modelled on the
same author's `karnataka-asddo-dashboard`. Repo:

    https://github.com/gouthamganeshm/Karnataka_Draft_Roll_2026   (branch: main)

Nothing about it is operated by or affiliated with the ECI, and the site must
never suggest otherwise. The agreed wording is:

> Independent search interface built using publicly available Election
> Commission of India electoral-roll data.

### Standing constraints from the user — do not relax these without asking

1. **Never bypass, defeat, or automate a CAPTCHA.** (This turned out to be moot;
   see section 2.) If one is genuinely required, it stays a manual human step.
2. **Never mark anything "verified" that was not actually tested.**
3. **Never commit PDFs to git.** Keep the repo small. `cache/` and `data/` are
   gitignored and must stay that way.
4. **Kannada (`KAN`) only**, not English.
5. Prefer open-source tools; keep the pipeline resumable, reproducible, and
   carrying source/version metadata.
6. Scope started deliberately small — one district — to be scaled after results.

### Open data-quality issue — confirmed wrong, NOT fixed, do not lose track of this

**AC112 (Bhadravathi)/part202/serial476: published `ok:true` EPIC is
`INA8000960`, confirmed wrong — true value is `INA1800960`.** This is the
original example that kicked off the whole "OCR misreads that pass every
check" investigation (see that section below). Unlike AC161's WZU/WZZ
(a letter confusion, fixed 2026-08-31 by `scripts/fix-ac161-wzu-wzz.mjs`),
this is a **digit** confusion, and the batch-size experiment found it reads
wrong at *every* batch size tested, including fully isolated (size 1) — not
a batching artifact, Tesseract just misreads this specific glyph regardless
of context. **No fix method is known for this one yet.** Still sitting
unfixed in `cache/rows/112.jsonl` as of 2026-08-31 — confirmed by directly
grepping that file, still reads `INA8000960`. Revisit once the 10,000-card
generic-fix sampling work (requested by the user, see the task list) is
underway — this exact case is a good test of whatever generic detection
method comes out of that.

---

## 2. The decisive finding (verified)

**Every published part PDF sits at a deterministic public path on ECI's own CDN,
with no CAPTCHA, no cookie, no session and no required header:**

    https://voters.eci.gov.in/eroll/2026/s10/sir-draftroll/{ac}/2026-EROLLGEN-S10-{ac}-SIR-DraftRoll-Revision1-{LANG}-{part}-WI.pdf

Note the case split: directory segments are lowercase (`sir-draftroll`), filename
segments are not (`SIR-DraftRoll`). It cannot be built from one casing.

Verified by fetching AC 196 part 227 cold with `curl` and comparing to the copy
the user downloaded by hand through the portal UI: **SHA-256
`01e9555e…c402699e`, 10,198,409 bytes, byte-identical.**

The CAPTCHA on the portal guards `generate-published-pdfs`, and that endpoint
**only returns this same path as a string** (`refId: "CDN"`). The file itself is
public. So skipping that call bypasses nothing — it declines to ask a question
whose answer is already known. This is the whole reason the project is viable.

### API map (all tested)

| Endpoint | Method | CAPTCHA | Notes |
|---|---|---|---|
| `gateway-voters.eci.gov.in/api/v1/common/districts/S10` | GET | no | open; EN + KN names |
| `.../api/v1/common/acs/{districtCd}` | GET | no | open; EN + KN names |
| `.../get-ac-languages` | POST | no | plain JSON; returns `{ENG, KAN}` for every AC |
| `.../get-publish-part-list` | POST | no | **body is encrypted** (hybrid RSA+AES, `encryptedPayload`/`encryptedKey`, plus `accept_yek`/`accept_rotcev` headers = "key"/"vector" reversed). Not reimplemented. |
| `.../generate-published-pdfs` | POST | **yes** | returns only the CDN path above — skipped |
| the CDN PDF itself | GET | no | see above |

`/download-sir-draft-roll` redirects to `/login` and needs an ECINET account —
strictly worse than the anonymous `/download-eroll?stateCode=S10` route.

### The CEO mirror is stale — do not use it

An earlier premise (still visible in old README history) was that ECI was a dead
end and the CEO's `ac_names.csv` was the source. **That is inverted.** Measured:
the CSV lists **43,398** parts statewide where the draft has **60,923** (29%
short); **226** parts for AC 196 where the draft has **282**; and part 227 — a
real, published booth — is **absent entirely**. All fallback code that read it
has been deleted from `1-discover.mjs`.

Booth **names** are likewise not carried over from it. The draft renumbered
parts, so an old name can land on a different booth, and a wrong booth address
sends a voter to the wrong ERO counter. Parts currently carry a number and an
empty name. (Open item — see section 7.)

### Statewide reconnaissance (verified)

- **224/224** ACs reachable on KAN part 1. Mean PDF ~9.6 MB, so **~571 GB** for
  the whole state if every part were fetched.
- Part counts recovered by doubling + binary search on the CDN, validated against
  API ground truth (AC 194 = 281, AC 196 = 282). Contiguity confirmed by
  enumerating all 282 parts of AC 196: no holes, nothing past the end.
- Distribution: min 191, **median 265**, max **605** (AC 176 Bangalore South).

---

## 3. Pipeline

    scripts/1-discover.mjs   districts + ACs from the gateway; part counts probed
                             from the CDN  ->  cache/manifest.json, cache/ac-index.json
    scripts/2-extract.py     streams each part PDF, OCRs in memory, appends to
                             cache/rows/<ac>.jsonl; PDF bytes never hit disk
    scripts/3-build-data.mjs SHA-256 hash buckets  ->  data/
    scripts/4-upload-r2.mjs  optional Cloudflare R2 upload
    scripts/5-publish.mjs    rebuild into docs/data, commit, push  <- how the
                             site is now updated; Actions is not involved
    scripts/probe-cdn.mjs    diagnostic only, not part of the pipeline: can this
                             host read the PDFs at all?  (see section 5)
    scripts/8-remaining.mjs  diagnostic: diffs cache/manifest.json against every
                             cache/done/<ac>.txt and writes cache/remaining-parts.json
                             -> which booths are not yet OCR'd, per AC, so the
                             tail end of the statewide pass can be finished with
                             `--ac`-targeted reruns instead of rescanning
                             everything. `2-extract.py` is already resumable on
                             its own (skips anything in the done ledgers), so
                             this changes nothing about how extraction runs —
                             it only tells you where to point it.
    docs/                    the static site

**Resumability**: every finished part is recorded in `cache/done/<ac>.txt` and
skipped on re-run. A statewide pass is days of compute and *will* be interrupted.

**Row honesty**: rows that fail validation are written with `"ok": false`, never
dropped. A part that could not be read must reduce *coverage* so the site
withholds its verdict — it must never look like a booth whose electors simply
are not there. The site suppresses negative verdicts below **99% coverage**.

**Lookup shape** (`docs/app.js`): buckets are **arrays** of
`[suffix, ac, part, serial]`, sorted, binary-searched. `manifest.shardDepth` and
`manifest.suffixLength` drive the path. *(A previous session wasted time on a
false negative caused by testing them as objects — they are arrays.)*

### OCR (`scripts/ocr/roll_ocr.py`)

The PDFs are image-only, no text layer. PyMuPDF (`fitz`) extracts page images,
Tesseract reads them. Three accuracy layers:

- **geometry** — ink-trimmed crops taken from detected rules
- **grammar** — `EPIC_RE = [A-Z]{3}[0-9]{7}`, plus `coerce_epic`
- **sequence** — `repair_serials`, a piecewise-constant offset fit with a
  rolling-mode window of 15

Cards are OCR'd 30-to-a-**contact sheet** rather than individually, for cost.

**The serial fix (done, measured).** Root cause was found by rendering the
failing crops as an image: they were perfectly legible, so geometry was fine and
the contact-sheet pass (`psm 6`, no whitelist) was at fault. `reread_serial()`
now re-OCRs any serial the sequence fit is not confident in, alone, as
`--psm 8` with a digits-only whitelist, then re-fits.

| | before | after |
|---|---|---|
| AC 196 part 227 | 10.4% flagged | **5.9%** |
| AC 177 parts 1-3 | 7.0% flagged | **3.7%** |

Costs ~170 ms. Counter-intuitive measured results worth not re-discovering:
padding to 24px/140px was **worse** (6/82 vs 34/82), and the second pass changed
the *fitted* serial exactly **once in 792 cards** — it mostly confirms values
that were already right, which is why it is safe.

---

## 4. Current state

- Commits: `5f7afb6` (initial, 19 files) and `3eefd06` (CDN probe fix). Both
  pushed to `main`. The user's git credential carries `workflow` scope.
- **Scope chosen**: district `S1034` **BANGALORE URBAN**, 7 ACs, **3,354 parts** —
  AC 150 Yelahanka 418, 152 Byatarayanapura 442, 153 Yeshwanthapura 553,
  155 Dasarahalli 419, 174 Mahadevapura 533, 176 Bangalore South 605,
  177 Anekal 384.
- Local OCR progress **preserved, not lost** (gitignored, on this machine only):
  `cache/rows/150.jsonl` = 50,567 rows / 65 parts done;
  `cache/rows/177.jsonl` = 1,614 rows / 3 parts done. ~4.7 MB total.
- Local extraction was stopped once ("stop local run, run in github actions"),
  then **restarted on 2026-08-24** when the runner turned out to be blocked and
  the user had no access to the machine themselves ("u can do it"). Full pass
  over all 7 ACs, 3,281 parts outstanding at the time, 11 workers, logging to
  `cache/extract.log`. Measured **9 parts/min** once the pool warmed, i.e. ~6 h,
  and it is resumable, so an interruption costs only the part in flight.
- End-to-end already validated once locally: discover -> extract (AC 177, 3
  parts) -> build (16 buckets, 1,555 electors) -> lookup
  (`AAH4480430` -> AC 177 part 3 serial 1; an absent EPIC correctly suppressed at
  0.09% coverage).
- Measured local throughput: **6.45 parts/min** (26 parts in 242 s).

---

## 4e. Throughput investigation — 2026-08-25, ~9-10 parts/min is a hard ceiling

The user asked whether OCR could be sped up with more parallelism. Measured,
in order:

1. **Tesseract's own threading was uncapped.** Each of 11 worker *processes*
   spawns a Tesseract subprocess per OCR call, and Tesseract's LSTM engine
   also opens its own OpenMP thread pool inside each call unless told not to
   — 11 processes each opening a handful of threads means 30+ threads
   contending for 12 cores. Fixed: `TESS_ENV = {**os.environ,
   'OMP_THREAD_LIMIT': '1'}` in `scripts/ocr/roll_ocr.py`, passed to both
   `subprocess.run` call sites. Correct to have either way, but **measured
   effect was flat**: 100 parts before vs after, both ~9.6 parts/min.
2. **Tried 20 workers instead of 11.** Also flat — 9.4 parts/min — and
   per-part latency actually got *worse* (69s -> 128s effective, at 11 vs 20
   workers respectively) while total throughput did not move. That is the
   signature of a ceiling independent of local concurrency, not a resource
   this machine can add more of.
3. **Ruled out the two obvious local causes.** A single isolated fetch (no
   contention) pulled a 7.7MB part in 1.55s — ~33 Mbps, far above the ~1.2MB/s
   aggregate implied by 9.5 parts/min, so it is not this connection's
   bandwidth. Windows Defender real-time protection is disabled on this
   machine (`Get-MpComputerStatus`), so it is not per-process AV scanning
   either — a live theory until checked, since spawning hundreds of short-lived
   `tesseract.exe` processes is exactly the shape of workload AV scanning
   hits hardest.
4. **Most likely explanation, not fully proven**: the ECI CDN itself throttles
   aggregate throughput per client, independent of how many local connections
   ask for it. Consistent with the rest of this project's experience of that
   edge — it already treats `fetch` vs `curl` differently and blocked GitHub's
   runners outright (section 5) — so a soft per-client cap on total bandwidth
   would not be a surprising addition to that pattern.

**Decision: left at the default 11 workers**, not 20. Pushing concurrency
further bought nothing in the test and risks provoking the same kind of edge
pushback documented in section 5, for no measured benefit. If this is
revisited, the highest-value untried lever is probably eliminating Tesseract's
per-call *process-spawn* cost itself (persistent OCR via `tesserocr` instead
of shelling out per call) rather than more parallelism — but that is a new
build dependency and a real architecture change, not attempted here.

## 4d. Scope expansion — 2026-08-24, priority queue now 8 districts / 68 ACs

The user's instruction, verbatim: finish all Bengaluru districts, then Hassan,
then one North Karnataka + one South Karnataka district as a statewide taste,
then queue the rest of the state later. "Keep your intervention minimal,
interrupt only when necessary."

North/South picks were a judgment call, not asked for by name: **Belgaum**
(S1001, 18 ACs — the largest North Karnataka district) and **Mysore** (S1028,
11 ACs — the largest South Karnataka one, after Bengaluru). Flagged to the
user, not yet confirmed either way.

District codes (verified against the live gateway, not assumed from an older
note — BBMP turned out to be three codes separate from Bangalore Urban, not a
subset of it):

| Priority | District | Code | ACs |
|---|---|---|---|
| 1 (in progress) | Bangalore Urban | S1034 | 7 |
| 2 | BBMP Central | S1031 | 7 |
| 3 | BBMP North | S1032 | 7 |
| 4 | BBMP South | S1033 | 7 |
| 5 | Bangalore Rural | S1022 | 4 |
| 6 | Hassan | S1025 | 7 |
| 7 | Belgaum | S1001 | 18 |
| 8 | Mysore | S1028 | 11 |

**Total: 68 ACs, 19,801 parts** (was 7 ACs / 3,354 parts). At the measured
9 parts/min this is roughly **36 hours of continuous OCR**, not a few — said
plainly here since nobody should discover that by watching a progress bar.

### How the queue is actually implemented — read this before changing scope again

Two bugs in `1-discover.mjs` would have broken this quietly if left as they
were, both fixed in the same pass:

1. **AC discovery order used to depend on network timing.** Each district's
   ACs were pushed into one shared array from inside a concurrent `pool()`
   worker; whichever district's API call happened to land first won that
   position, regardless of `--district` order. Fixed by having each worker
   *return* its list and flattening after `pool()` resolves, which preserves
   input order regardless of completion order.
2. **`1-discover.mjs` used to overwrite `cache/manifest.json` outright.**
   Running it again for the next district would have erased Bangalore Urban's
   entry — not the OCR'd rows themselves (`cache/rows/`, `cache/done/` are
   untouched), but the coverage math in `3-build-data.mjs` reads constituency
   totals from the manifest, so the site would have silently undercounted a
   district that was, in reality, already ~51% done. **A scoped `--district`
   run now merges into the existing manifest**, keeping every previously
   discovered AC in its position and appending new ones in the order
   `--district` named them — full behavior and header comment in the file.
   A bare run with no `--district` (whole state) is unchanged: it still
   replaces the file, since there is no prior scope to protect.

`2-extract.py` reads `cache/manifest.json`'s `constituencies` array in file
order and (per `ProcessPoolExecutor`'s roughly-FIFO submission) works through
it close to that order. **That ordering — not a separate scheduler — is the
priority queue.** Verified in a scratch cache dir before touching the real
one: district order came out `S1034,S1031,S1032,S1033,S1022,S1025,S1001,S1028`
exactly as requested, and every one of S1034's 7 ACs kept its original part
count untouched.

### `2-extract.py` is one-shot — `scripts/2-extract-forever.mjs` supervises it

This was the actual gap between "grow the manifest" and "the automation
workflow has this queue" that the user asked for. `2-extract.py` reads the
manifest once at startup and exits when its job list is empty — it does not
notice the manifest growing later. Left alone, finishing Bangalore Urban would
have meant the pipeline going idle until someone noticed and re-ran it by
hand, the opposite of "minimal intervention."

`scripts/2-extract-forever.mjs` restarts `2-extract.py` every time it exits,
so a finished batch leads straight into re-checking the manifest. It stops
once a restart genuinely finds nothing left. This **is** the resumable local
ledger the user asked for on top of the per-part one: `cache/manifest.json`
(what's in scope, grown additively) + `cache/done/<ac>.txt` (what's finished,
already existed) together mean a crash anywhere — mid-part, mid-AC, or the
whole machine — loses at most the parts that were literally in flight.

Running now: the old one-shot `2-extract.py` invocation was stopped cleanly
(`cache/done/` proves only one in-flight part was lost) and replaced with the
supervisor. **First bug caught immediately**: forgot `PYTHONUNBUFFERED=1` on
the first attempt — workers were provably running (rising memory in
`tasklist`) but stdout was stuck in Python's block-buffer since it is now
redirected to a file, not a TTY. Harmless (done-markers are `flush()`'d
independent of stdout) but made a many-hour run indistinguishable from a
hang, so it was worth a restart before the run got long. Fixed and confirmed:
restarted, job count printed immediately (`17879 parts to read` — exactly
19,801 minus the 1,922 already done).

**A pre-existing OCR gap, not caused by this change**: the 6 parts of AC 152
that were already stuck before this session (436/442 done) fail with
`ValueError: Coordinate 'right' is less than 'left'` — a crop geometry bug on
some page shape `find_grid`/`card_header` do not handle, most likely a
supplementary or oddly-laid-out page. These do not get marked done, so every
future round will keep retrying and keep failing on exactly these 6 — AC 152
will plateau at 436/442 until someone fixes the geometry case. 6 of 19,801
parts (0.03%); not chased further this session, flagged here so it is not
mistaken for a new regression. **Fixed 2026-08-29 — see section 4g.**

## 4f. Full-state queue — 2026-08-25, ascending by booth count, all 34 districts

The user's instruction, verbatim: after Hassan, queue every remaining district
in ascending order of booth count, lowest to highest, and make sure every
district is covered — superseding the earlier "Belgaum + Mysore as one
North/South taste" judgment call from 4d, which was explicitly flagged there as
not yet confirmed.

There is no cheap API for a district's booth count — `1-discover.mjs`'s own
header explains why (parts are recovered by binary-search probing the CDN, not
read from an endpoint). So sizing the remaining 28 districts required actually
running discovery for all of them first, in a scratch `ROLL_CACHE` dir
(`/tmp/scratch-discover`, same isolation pattern as 4d), before touching the
real manifest — otherwise there would be no way to know the right order to
commit them in.

That scratch run (`--concurrency 8`, 185 ACs, 0 failed) gave the true ascending
order:

| District | Code | ACs | Parts |
|---|---|---|---|
| Kodagu | S1027 | 2 | 567 |
| Gadag | S1008 | 4 | 983 |
| Chamarajnagar | S1029 | 4 | 1,030 |
| Yadgir | S1035 | 4 | 1,162 |
| Ramanagaram | S1023 | 4 | 1,183 |
| Udupi | S1016 | 5 | 1,244 |
| Chikkmagalur | S1017 | 5 | 1,255 |
| Bellary | S1012 | 5 | 1,260 |
| Vijayanagara | S1036 | 5 | 1,301 |
| Koppal | S1007 | 5 | 1,352 |
| Chikkaballapur | S1019 | 5 | 1,361 |
| Uttara Kannada | S1010 | 6 | 1,523 |
| Haveri | S1011 | 6 | 1,559 |
| Kolar | S1020 | 6 | 1,578 |
| Bidar | S1005 | 6 | 1,579 |
| Dharwad | S1009 | 7 | 1,707 |
| Chitradurga | S1013 | 6 | 1,764 |
| Davangere | S1014 | 7 | 1,808 |
| Bagalkot | S1002 | 7 | 1,855 |
| Shimoga | S1015 | 7 | 1,886 |
| Mandya | S1024 | 7 | 1,889 |
| Raichur | S1006 | 7 | 1,892 |
| Dakshina Kannada | S1026 | 8 | 2,019 |
| Bijapur | S1003 | 8 | 2,159 |
| Gulbarga | S1004 | 9 | 2,461 |
| Tumkur | S1018 | 11 | 2,745 |
| Mysore | S1028 | 11 | 2,967 |
| Belgaum | S1001 | 18 | 4,644 |

**A real bug, caught before it reached the extraction pool.** `S1001` and
`S1028` were already sitting in `cache/manifest.json` from the earlier
judgment call, positioned right after Hassan. Running `1-discover.mjs
--district <the other 28, ascending>` correctly appended those 28 in order —
but merge-and-append means *already-present* districts keep their *existing*
position, so Belgaum and Mysore stayed at the front of the new block instead
of sliding into their correct ascending slots (18-AC Belgaum would have run
right after Hassan, ahead of 2-AC Kodagu — exactly backwards). Fixed with a
one-off in-place sort of `constituencies` (and `districts`) by a rank map built
from the full target order above; no re-fetch needed, since all 34 districts'
data was already sitting in the manifest by that point. Verified after: the
district sequence reads `S1034,S1031,S1032,S1033,S1022,S1025` then the 28-row
table above in exact order, `S1001` (Belgaum) last.

**Final state: 34 districts, 224 ACs, 60,923 parts** — matches the number
`1-discover.mjs`'s own header comment cites as the true statewide total (vs.
the stale CEO CSV's 43,398), so this is confirmed full coverage, not a partial
scope that happens to look complete.

At the measured ~9.5 parts/min and 7,486 parts already done at the time of this
expansion, the remaining ~53,437 parts are roughly **94 hours** of continuous
OCR — said plainly for the same reason 4d said it: nobody should discover the
real timeline by watching a progress bar. `2-extract-forever.mjs` needs no
changes — it re-reads `cache/manifest.json` on every restart, and this was a
reorder of an already-additive file, not a new mechanism.

`6-auto-publish.mjs` needed **no changes** — it already watches `cache/done/`
generically. Confirmed: first publish after the scope grew came out correct
on its own, `1,922/19,801 booths (9.7%), 68 ACs` — the moment work spans 68
ACs instead of 7, the coverage math picked it up with zero intervention.

### Verification — `scripts/7-verify.mjs`, spot-checks a finished AC

Added because the user asked specifically to be the one doing testing while
automation does the OCR. Two independent layers: (1) samples rows from
`cache/rows/<ac>.jsonl` and confirms the live site's real lookup path
(SHA-256 -> bucket -> binary search, over actual HTTP) returns the same
AC/part/serial; (2) for a few of those, re-fetches the source PDF from the
CDN and re-runs the pipeline's own OCR reader against it, independent of
whatever the original pass produced.

    node scripts/7-verify.mjs --ac 150,153 --sample 15 --pdf-checks 3

**Both already-complete ACs verified clean**, first run for this project:
AC 150 (29/30 site matches — the one miss was a GitHub Pages CDN propagation
race, confirmed resolved by re-querying seconds later, not a data bug) and
AC 153 (15/15, 3/3 PDF re-reads). One record, AC150 part 15 serial 182
(`XTE5125596`), was additionally confirmed by rendering the actual page and
reading the printed card by eye rather than trusting any automated OCR path.

Hardened after the first run crashed the whole batch on one dropped
connection (`ECONNABORTED` fetching a PDF) — a multi-megabyte fetch over a
long loop hits the occasional reset that has nothing to do with the data
being checked. Now retries a PDF fetch once and wraps each AC's checks so one
network hiccup fails that AC, not the whole batch.

Not yet run against every AC as it completes automatically — that is what the
`/loop` running alongside this conversation is for; see its own state for
what it has and has not gotten to.

## 4c. Name, age, gender — tried, declined 2026-08-24, do not re-raise lightly

Asked for explicitly, then declined by the user in the same conversation once
the tradeoff was in front of them. **Only the source-PDF link shipped** (see
4b); no name/age/gender code was committed anywhere.

What was actually found before the decline, in case this comes up again:

- The card layout **is** exactly what was asked for — below the header
  (serial + EPIC) every card has four plain text lines: ಹೆಸರು (name), ತಂದೆಯ/
  ಗಂಡನ ಹೆಸರು (father's/husband's name), ಮನೆಯ ಸಂಖ್ಯೆ (house number), then
  ವಯಸ್ಸು + ಲಿಂಗ (age + gender) sharing one line. Confirmed visually against a
  rendered page (AC 177 part 3). Geometry to isolate the four lines (ink-gap
  splitting below the header, symmetric to the existing header-box detection)
  worked cleanly in a scratch test.
- **Kannada name OCR itself did not work well enough to trust.** `kan.traineddata`
  (tessdata_best, since eng is the only model installed system-wide and Program
  Files is not writable without admin — it was placed at
  `~/tessdata/kan.traineddata` instead, machine-local, not in the repo) produced
  garbage on several of the first eight cards tried — e.g. "ರ್ಪ್ಚ್ರಾಾಾು" for a
  name, correct only when the name happened to be short and simple. Age
  (plain digits) and gender (one of three fixed Kannada tokens) looked
  tractable; **name did not**, and there is no grammar or sequence check for a
  name the way `EPIC_RE` and serial-continuity check the other two fields — a
  wrong name would ship with nothing to catch it.
- The harder objection, independent of accuracy: storing name/age/gender in the
  public hash-bucket files makes the **full elector list** (name, age, gender,
  booth) crawlable **without needing anyone's EPIC** — no EPIC is stored in a
  bucket today specifically so a bucket file alone is useless. That is the
  scrapeable-registry outcome the current design's own site copy says it
  refuses to become. Raised to the user before building further; they declined
  once they saw the tradeoff stated plainly.

If this is revisited: fix the OCR accuracy problem first and separately from
the publication-shape problem. Test-driving `kan.traineddata` against a larger
sample before touching `roll_ocr.py` would have caught the accuracy problem
before the harder question needed asking at all.

### Study, not implementation — 2026-08-28, revisit-when-final-rolls-drop numbers

Asked again as a study only ("don't implement, may be we can take this up when
final rolls r released") — no code or pipeline changes made. Numbers below are
grounded in the live statewide run, for whenever this gets re-raised.

**Geometry is not the hard part.** The four extra card lines (name /
father's-husband's name / house number / age+gender) were already located
cleanly in the 2026-08-24 scratch test, symmetric to the existing header-box
detection.

**Compute cost**, from this run's real throughput: statewide is 224 ACs,
60,923 parts, ~41.7M electors (projected from 26.26M published at 63.03%
coverage on 2026-08-28). EPIC+serial-only runs ~7 parts/min sustained on 11
Tesseract workers on one machine → a from-scratch statewide pass is ~145h
(~6 days), matching what's actually been observed. Full-card OCR, per this
file's own ~5x-cost estimate for reading the whole card, projects to
**~30 days of continuous compute** at the same worker count for a from-scratch
statewide pass. Scales down roughly linearly with more workers/machines.

**Accuracy is the real unknown.** Even the two easy, grammar-correctable
fields aren't clean today: 1,352,780 rows (4.9% of ~27.6M scanned) are
withheld as low-confidence, plus 23,318 duplicate EPICs, *despite*
`coerce_epic` and serial-sequence repair actively fixing most OCR slips.
Names have no equivalent correction mechanism, so expect a materially higher
unreadable/wrong rate — the 2026-08-24 test already saw garbage on several of
the first 8 cards. The cheap next step, if this gets re-raised, is exactly
what the paragraph above already recommends: OCR a few hundred cached name
crops and hand-check them against the source PDF, before touching
`roll_ocr.py` — that produces a real number instead of an estimate, and
still touches nothing live.

**The publication-shape objection is unresolved, not obsolete.** A middle
ground not considered on 2026-08-24: show full detail only after an *exact*
EPIC match, never in bucket/browse results — brute-forcing one known EPIC
isn't the same as browsing a booth's full roll. Worth raising explicitly if
this comes back, since it changes the scrapeable-directory calculus that
drove the original decline.

**Addendum, same day: English rolls as the OCR source, aimed at duplicate
detection specifically.** ECI publishes an ENG PDF at the same CDN path per
part (swap `KAN`→`ENG` in the filename; confirmed live, no captcha, ~7%
larger file than the KAN version for AC2 part4). Tesseract's `eng` model is
mature and already installed, unlike the Kannada model that produced garbage
on names — a real reason to expect materially better name-OCR accuracy than
the 2026-08-24 attempt, though still unverified without a sample test. Caveat:
English is ECI's transliteration, not the canonical Kannada source this
project deliberately chose, so it's a source for *matching*, not for
authoritatively publishing "this is the elector's name."

Duplicate detection (same-booth and, harder, cross-booth/cross-AC) is
standard record-linkage once name/age/gender/relative's-name exist: block on
soundex(name)+age±1+gender, fuzzy-score with Jaro-Winkler, threshold for
review — days of work with `recordlinkage`/`dedupe`, not weeks. OCR compute
is still the dominant cost and doesn't drop much by switching language
(~5x header-only, ~30 days continuous compute statewide at current scale).
Importantly, a duplicate-finder's *output* doesn't need to publish PII at
all — flagged EPIC pairs or per-AC duplicate counts sidestep the
scrapeable-registry objection that killed the name-search idea, since the
output is a review list, not a lookup tool. This is a materially easier
product decision than the original ask.

Next cheap step if revisited: OCR ~50-100 cached English-roll name crops and
hand-check against the source PDF — turns the accuracy question from an
estimate into a real number. Not run yet; still just study.

## 4g. Two fixes — 2026-08-29, cross-district validation against the CEO press
note surfaced both

Cross-checking the first 8 districts to reach 100% coverage against the CEO's
28.08.2026 press note (statewide 4,46,35,948 electors) found every district
landing at a consistent 94.8-95.4% of the official count — no outliers, but a
real, explainable shortfall worth chasing since the gap is uniform rather than
random.

**Fix 1 — the AC152 crop-geometry crash (referenced in section 9) was not
AC152-specific.** Same `ValueError: Coordinate 'right' is less than 'left'`
was hitting AC152, AC168, AC176, AC177 and AC110 on specific parts,
deterministically on every retry (confirmed via `cache/extract.log`: the same
part numbers fail every single round). Root cause: `card_header` in
`scripts/ocr/roll_ocr.py` computes a card's serial/EPIC crop boxes from
detected rule positions and calls `im.crop()` without checking the box is
non-degenerate first — on a card where rule-detection lands on a near-zero-
width box (noise on the source page), PIL raises rather than clamping, and
that exception was uncaught, killing the *entire part* (do_part in
`2-extract.py` catches it as `{'error': ...}` and never writes the part to
`cache/done/<ac>.txt`), so it retried and failed identically forever. Fixed by
validating both crop boxes in `card_header` before cropping and returning
`None, None` (already-handled "unreadable card" path) instead of raising.
Verified directly against two previously-permanently-failing parts (AC152
part 359, AC177 part 235) — both now read cleanly (486 and 468 rows). This
unblocks every AC that had a part stuck on this bug from ever reaching 100%;
AC177 (Anekal) was sitting at 383/384 for exactly this reason.

**Fix 2 — most of the "low-confidence" shortfall was a publishing-gate
problem, not an OCR-accuracy problem.** Broke down the ~4.6% of rows withheld
as `ok: false` across the 8 complete districts (8.1M rows): **95.3% have a
grammar-valid EPIC** and are withheld *only* because the part's serial
sequence-fit (`repair_serials` in `roll_ocr.py`) could not independently
confirm that row's position — the EPIC itself was read correctly. Only 4.7%
of withheld rows are genuine EPIC misreads. `scripts/3-build-data.mjs` was
dropping both cases identically (`if (!row.ok || !EPIC_RE.test(epic))`),
discarding a correctly-read elector from search over an unconfirmed serial
number alone. Changed the acceptance rule to publish any row with a
grammar-valid EPIC; rows where `row.ok` was false get a trailing `1` appended
to their record tuple (`[hash8, ac, part, serial, 1]`) marking the serial as
approximate rather than OCR-confirmed. `docs/app.js` shows a caveat line
(`approxSerialNote`, both languages) when that flag is present, pointing to
the source PDF as authoritative. No new OCR needed — the EPIC was already
sitting in `cache/rows/*.jsonl`; this only required reprocessing already-read
rows through a full rebuild (`node scripts/3-build-data.mjs --full`) to
retroactively recover them, since the incremental build path only processes
rows past its `build-state.json` checkpoint. Projected effect: shortfall
against official district totals should drop from ~4.6% to roughly ~0.2%
once the full rebuild ships.

**Coordination note for future full rebuilds**: `3-build-data.mjs --full`
starts by `rm`-ing `docs/data` before rewriting it, and the auto-publish loop
(`scripts/6-auto-publish.mjs`) runs its own (incremental) build/commit/push
cycle on the same directory every ~30-45 min. Running a manual full rebuild
while that cycle is mid-flight is a real race (confirmed a `git push` from an
in-flight cycle can run 10-15+ minutes on this connection/tree size) — wait
for `cache/publish.log`'s latest line and no active `git.exe` process before
starting one by hand.

## 4h. Three more bugs — 2026-08-29, later the same day as 4g

The full rebuild needed to retroactively apply 4g's two fixes to already-read
data stalled the site for **~5 hours** (last good publish 06:45, next one
11:10) on two new bugs neither previous session had hit, because the dataset
crossed a size threshold neither had reached before. A third, more important
finding: **4g's crop-geometry fix was never actually live**, despite reading
as verified there. All three found by the user pushing for "robust testing"
of new vs. old data rather than trusting the fix commits at face value.

**Bug 1 — `ENOTEMPTY` deleting `docs/data`.** `3-build-data.mjs`'s full-rebuild
path opens with `await rm(DATA, { recursive: true, force: true })`. Starting
~07:28, every attempt crashed with `ENOTEMPTY: directory not empty, rmdir
'...\docs\data\roll\<random 2-hex dir>'` — a different bucket subdirectory
each time (`43`, `40`, `89`, `d5`, ...), the signature of a transient
Windows AV/indexer lock racing the delete rather than anything wrong with the
tree itself. `fs.rm`'s own Windows retry logic defaults to `maxRetries: 0`, so
it never self-healed. First fix attempt (`maxRetries: 5, retryDelay: 200` —
~1s budget) **was not enough** and still failed once. Widened to
`maxRetries: 30, retryDelay: 500` (~15s budget), which held.

**Bug 2 — heap OOM once bug 1 stopped masking it.** With deletion no longer
crashing first, rebuilds ran long enough to hit a second wall: `FATAL ERROR:
... JavaScript heap out of memory` at ~29.4M of 36M rows, during the
in-memory bucket-accumulation pass. The full-rebuild path holds every row in
memory (`Map<prefix, Set<suffix>>` + `Map<prefix, record[]>`) before writing
anything to disk, and at this row count that now exceeds Node's default
~4GB heap ceiling — a size threshold the dataset had not crossed before
today. Fixed by passing `--max-old-space-size=6144` when `5-publish.mjs`
spawns `3-build-data.mjs`. Checked headroom first, not assumed: this machine
has 15.6GB total RAM, and the OCR pool's ~10 Tesseract workers were only
using ~3.5GB combined at the time, so 6GB for the build process left comfortable
margin for both plus the OS.

Both bugs together, compounding on the pre-existing checkpoint-mismatch issue
(4g) that was already forcing every publish into a full rebuild, are why the
site went stale for ~5 hours before the fixes landed. A side effect worth
naming: diagnosing bug 1 was slower than it should have been because the
auto-publish supervisor's stdout redirect had been pointed at a log file that
was later `rm`'d while still open for writing (see the `dont-rm-live-logs`
lesson from earlier the same day) — the redirect target existed on disk but
had stopped receiving new content, so the supervisor looked silent right when
its error output was needed most. Restarting the supervisor with a fresh,
correctly-captured log was what actually surfaced bug 1's stack trace.

**Bug 3 — the more important one: 4g's crop-geometry fix was committed but
never deployed.** `2-extract.py` is one-shot by design (documented in section
4d) — it loads `roll_ocr.py` once at process start and works through its job
list for the life of that process. The running extraction workers had started
**2026-08-24 and 2026-08-26**, well before the fix landed in
`roll_ocr.py` at **06:32 on 2026-08-29**, and kept running on the pre-fix
code for another ~9 hours with nothing to signal the fix wasn't live — no
error, no warning, just the same parts continuing to fail exactly as before.
Confirmed directly: `cache/extract.log`'s *current* pass (started long after
the fix commit) was still throwing the identical `ValueError: Coordinate
'right' is less than 'left'` on AC152 parts 359/360/361/362/437/438 and
others. The true scope was also wider than 4g's write-up suggested — not
just the 5 ACs originally identified (AC110/152/168/176/177), but **61 stuck
parts across 40 ACs**, all silently accumulating against the same
never-deployed fix. Fixed by killing and restarting
`scripts/2-extract-forever.mjs` — safe by the supervisor's own design
(section 4d): the `cache/done/<ac>.txt` ledger means a restart costs at most
the one part that was mid-flight. Verified after restart: 0 unreadable
across the next 325 parts processed, and every specific previously-stuck
part (AC152/359, AC177/235, etc.) completed with plausible row counts on the
very next attempt.

**The general lesson, worth not re-discovering**: verifying a fix against a
standalone repro (as 4g did, against two previously-crashing PDFs) confirms
the *code* is correct. It does not confirm the fix is *live*, if the code in
question is loaded once by a long-running supervised process rather than
re-read per invocation. `2-extract.py`'s workers, and any similar persistent
pool, need an explicit restart called out and done before a fix can be
considered deployed — the standing constraint "never mark anything verified
that was not actually tested" (section 1) applies to *deployment*, not just
*correctness*.

### Live state as of 2026-08-29 ~19:40 IST — read this if picking up cold

All three 4h fixes are committed (`f4648e2`) and confirmed live, not just
committed — see 4h's own lesson about that distinction. Coverage **87.3%**,
38,491,540 electors, 53,153/60,923 parts, latest push `df3b8a9`.

**Both long-running processes were just restarted detached** (`nohup ... &
disown`, not the native background-task mechanism), specifically because they
had drifted to being direct descendants of that session's own CLI process —
verified via full parent-chain walk (`Get-CimInstance Win32_Process`, follow
`ParentProcessId` to root) — and would likely have died with it otherwise.
If you're reading this after a session boundary and either process is not
running, that parent-chain check is the first thing to redo before assuming
something is actually broken versus just needing a restart:

    node scripts/2-extract-forever.mjs   # resumes from cache/done/<ac>.txt
    node scripts/6-auto-publish.mjs --interval 30

Both are safe to kill and restart any time **except** while a `git.exe`
process is a live child of the auto-publish tree (mid commit/push) — check
`Get-CimInstance Win32_Process -Filter "Name='git.exe'"` first, same
coordination note as 4g.

**Verification backlog in progress, not finished**: 184 ACs are at 100% but
only 131 + partial were in `cache/verified-acs.json` when this was written.
A batch verify (`node scripts/7-verify.mjs --ac <53 ACs>`) was started for
the remaining ones; 13/53 done and clean when this note was written, no
failures. If it didn't finish, just re-derive the list (any AC where
`manifest.acs[n].partsDone === manifest.acs[n].parts` and `n` is not a key in
`cache/verified-acs.json`) and re-run — cheap, idempotent, nothing depends on
finishing in one pass.

## 4b. Publishing — decided 2026-08-24, supersedes the Actions plan

The user's call after the runner kept returning 406: **"process the data locally
and push the json, part by part, instead of depending on GitHub Actions."**

So `docs/data/` is now **committed**, and `.gitignore` carries an explicit
`!docs/data/`. This is a deliberate, narrow relaxation of standing constraint 3
in section 1 — *no PDFs* still holds absolutely, and `cache/` and `data/` are
still ignored. Only the built JSON travels.

Measured, not estimated: **8.2 MB across 260 files at 14.0% coverage**, so the
finished district is **~58 MB in ~4,100 files**. That is well inside Pages' 1 GB
cap, and `scripts/4-upload-r2.mjs` stays unused until the scope grows.

Two things to know before republishing often:

- Stage 3 **clears its output directory and rewrites every bucket**, so each
  publish is a whole-tree churn in git history, not a delta. Publish at
  checkpoints — per constituency finished — not per part.
- `shardDepth` is derived from the row count and **flips from 2 to 3 at ~614,400
  rows** (16^2.5 x 600). At that point every bucket path changes from
  `roll/ab.json` to `roll/ab/c.json`. Expect one commit that rewrites the
  entire tree; it is correct, not a bug. The client reads `shardDepth` from the
  manifest, so old and new both work as long as manifest and buckets ship
  together — which they do, in one commit.

**Pages source must be `Deploy from a branch` -> `main` / `/docs`**, not
`GitHub Actions`. That is what removes the workflow from the path entirely.

Verified end-to-end against the published tree: `AAH4480430` -> `[092b831c, 177,
3, 1]`, and a bogus `ZZZ9999999` returns nothing.

### Automation — `scripts/6-auto-publish.mjs`, running since 2026-08-24

The user asked for this specifically ("process the data locally and push the
json, part by part, instead of depending on GitHub Actions" / "so data keeps
on adding without ur intervention"). It watches `cache/done/` and calls
`5-publish.mjs` whenever the count has grown, logging every cycle to
`cache/publish.log`.

**Not literally per-part.** A full publish rebuilds every hash bucket from
scratch (that is how a booth that turns out unreadable is guaranteed not to
linger in a stale one) and that rebuild alone measured **~47s at ~1M rows**,
before the commit and push. The OCR was completing a part every ~7s at its
measured 9 parts/min, so firing a publish per part would mean each one starts
before the last finishes, fighting the OCR pool for the same CPU. Polling
every 3 minutes instead was the judgment call made in place of asking —
flagged to the user as a deviation from the literal request, not yet
reaffirmed either way. It was run un-modified through two full cycles with no
intervention: 137f728 (14.3% -> 46.2%) and 852cd41 / b830df6f (-> 49.2%),
each appearing on the live site within about a minute of the push.

    node scripts/6-auto-publish.mjs                  # every 3 minutes, default
    node scripts/6-auto-publish.mjs --interval 300    # every 5 minutes
    node scripts/6-auto-publish.mjs --once            # single check, no loop

Leave it running for the rest of this district's ingest. `2-extract.py` and
`6-auto-publish.mjs` are two independent long-lived processes — killing one
does not affect the other, and both resume cleanly (`cache/done/` for
extraction, git history for publishing).

## 5. THE ACTIVE BLOCKER — read this first

`.github/workflows/build-roll.yml` (4 jobs: `discover` -> `extract` matrix ->
`build` -> `deploy`) was run for the first time and **the `discover` job failed**:
all 7 ACs reported "could not determine whether part 1 exists", i.e. the CDN
answered the GitHub runner with **neither 200 nor 404**.

Crucially: **the gateway API answered that same runner fine** (it listed the
district and all 7 ACs). So this is the roll-file host `voters.eci.gov.in`
specifically, **not** a blanket geo-block of ECI. From the user's own machine in
India everything is clean — verified `curl`: HEAD bare -> 200, HEAD with browser
UA -> 200, ranged GET -> 206, bogus part -> 404.

**Fix already pushed (`3eefd06`), not yet tested on a runner.** Three parts:

1. `partExists` now sends a **browser user-agent + referer** (Node's `fetch`
   otherwise sends `user-agent: node`).
2. An inconclusive HEAD is retried as a **one-byte ranged GET**, in case the edge
   simply dislikes HEAD.
3. The **actual status is no longer swallowed** — it is carried into the thrown
   error — and a `Probe the roll CDN` preflight step in the workflow prints the
   egress IP and full response headers for three request shapes *before*
   discovery runs.

The rewrite was re-run locally and reproduces **3,354 parts, 0 failed**, so it is
behaviour-preserving.

### What that run actually returned (2026-08-24)

The workflow was triggered and `discover` failed again — but `3eefd06` did its
job, because the non-answer now has a number on it. All 7 ACs:

    AC 150 part 1: GET -> HTTP 406 Not Acceptable

So the browser UA and the HEAD->GET fallback were **not** the cause. A 406 is an
edge deny decision, and the same commit run **from the user's machine reproduces
3,354 parts, 0 failed** — verified again on 2026-08-24, along with all 8 request
shapes returning 200/206 and a clean 404 on a bogus part. The block is on the
runner, not on the files, the path or the code.

Two candidate causes remain, with opposite remedies:

- **IP-level denial** of GitHub's egress -> not patchable from inside a workflow.
- **Client fingerprint** — undici's TLS handshake, header order and ALPN differ
  from curl's, and edge bot rules key on exactly that -> patchable, but note it
  would have to be patched in **two** places: `1-discover.mjs` (undici `fetch`)
  and `2-extract.py` (`urllib.request`). Neither is browser-shaped today.

### Next action

Trigger **Actions -> Probe roll CDN -> Run workflow** (defaults are fine). It is
a ~1-minute, one-job workflow added for exactly this, runnable from a phone; it
tries the same URL through 8 request shapes across both `fetch` and curl, checks
that a known-missing part still 404s, prints the egress IP, and ends with a
one-line VERDICT. It **exits non-zero when nothing worked**, so the red X is the
answer without reading the log.

`scripts/probe-cdn.mjs` runs locally too (`node scripts/probe-cdn.mjs`), which is
how the baseline above was measured.

**`1-discover.mjs` now also answers this on its own.** Its probe ladder is
`fetch HEAD -> fetch GET -> curl GET`, and the transport that failed is named in
the error. So a plain `build-roll` run is self-diagnosing:

- `curl GET -> HTTP 406` in the error -> **both** clients refused, so it is the
  IP. No transport change helps; the run needs a different egress.
- discover **succeeds** where it used to fail -> it was undici's fingerprint, and
  `2-extract.py` needs the same curl fallback for its `urllib` downloads before
  the extract stage can work on a runner. That change is **not** written yet.

Verified locally, both paths, identical output — 3,354 parts, 0 failed, via
`fetch` and again via `ROLL_PROBE=curl`. The env var exists only to exercise the
fallback on a host where `fetch` is fine; it is not needed in normal use.

Separately, before any run with `deploy = true`: **Settings -> Pages -> Source:
GitHub Actions** must be set, or the `deploy` job fails at the *end* of a long
run.

**Auth note:** `gh` is **not** authenticated in this environment and no
`GH_TOKEN`/`GITHUB_TOKEN` is set, so a session cannot enable Pages or trigger
`workflow_dispatch` from the CLI. A previous session declined to extract the
token from the git credential manager, since that means handling a credential in
plain text — keep declining. Either the user clicks it in the browser, or they
run `gh auth login` themselves (suggest they type `! gh auth login`).

Expected wall clock for the real run is bounded by the **largest** constituency,
not the total: AC 176 (605 parts) is about 4 h on one 4-vCPU runner, with the
other six finishing alongside. The matrix is `max-parallel: 8`,
`timeout-minutes: 350`, `fail-fast: false`, and caches rows per AC so a re-run
resumes.

### 2026-08-25 — GitHub Actions ruled out entirely, do not retry

Re-tested against **Bangalore Rural (S1022)**, a different district: `discover`
406'd again, and this time the error showed `curl GET -> HTTP 406` explicitly
(the ladder's last rung), meaning both `fetch` and `curl` — different TLS/header
fingerprints — were refused identically. That rules out request-shape as the
cause and, since two unrelated districts both failed the same way, rules out
anything data-specific too. What is left is the runner's IP itself.

Next tried **`runs-on: macos-latest`** on the `discover` job only (`ubuntu-24.04`
and `windows-latest` were not tried — both are still Azure VMs like
`ubuntu-latest`, so they would very likely repeat the same block; not worth a
run to confirm). macOS runners are **not** Azure VMs, so this tested whether
the block was Azure-specific. **Also 406'd.** GitHub publishes IP ranges for
every hosted-runner flavor precisely so sites can identify and block
automation traffic, and this CDN's edge appears to block that published set
broadly, not one cloud provider. Reverted to `ubuntu-latest` afterward — no
reason to keep `discover` on a different runner flavor than `extract`/`build`
once macOS was confirmed to offer nothing.

**A self-hosted runner is not a fix, and should not be tried as one.** It
would resolve the 406 (the request would originate from a normal residential
IP again) but only by making the job run *on whichever machine is registered
as the runner* — for a home setup, that is this same laptop. The network path
and the CPU doing the OCR would be identical to what `2-extract-forever.mjs`
already does directly; Actions would only add a scheduling layer on top of
work that is already running. No throughput gain, no new egress.

**Conclusion: this CDN is unreachable from GitHub Actions in every form that
provides genuinely separate compute.** The only path that could still reach it
from Actions is a proxy/VPN with a non-datacenter (e.g. Indian residential) IP
routed through the runner — which is deliberately working around a bot-defense
rule the site operator put up on purpose. That is a materially different kind
of workaround than anything else in this project (still no CAPTCHA bypass, no
auth bypass — the files themselves are public — but a step further into
evading access control than has been done so far) and needs the user's
explicit sign-off before it is ever attempted, not just a green light on
throughput grounds. Absent that, **local-only extraction is the only viable
path for this CDN** and should be treated as final, not a placeholder.

---

## 6. Environment gotchas (cost real time before)

- **Windows `cp1252`.** Kannada text breaks `json.load(open(...))`. Use
  `io.open(..., encoding='utf-8')` and set `PYTHONIOENCODING=utf-8`.
- **`$TMPDIR` does not resolve usefully** in this Git-Bash setup — it landed in
  `C:\Program Files\Git`. Use the full explicit scratchpad path.
- **Large `cat > file <<'EOF'` heredocs fail** in this shell (unmatched-quote
  parse error on content that is perfectly valid). Use the Write tool for
  anything long.
- **Editing files via Python `.replace()` silently no-ops sometimes.** Three
  attempts reported success while the file on disk was unchanged. Use the Edit
  tool, or verify with `node --check` / a re-read afterwards.
- **`sleep N && ...` is blocked** by the harness. Use `run_in_background` or a
  polling `until` loop.
- Watch for **scratch files landing in the repo root** when the shell cwd resets
  (`ac.json`, `ceo.html`, `d.json`, `main.js`, `sir.html` all appeared once).
  Check `git status` before committing.
- Past sessions produced **three successive wrong runtime estimates** by
  extrapolating from tiny or unflushed samples. Measure a clean delta or say
  nothing.

---

## 7. Open decisions — these belong to the user, do not settle them unilaterally

1. **The residual ~5.9% withheld rows.** `ok` requires *both* a well-formed EPIC
   *and* an OCR-confirmed serial. Many withheld rows have a valid EPIC and a
   near-certainly correct serial. Loosening `ok` would raise coverage but trades
   away a documented safety property. Alternative: build a digit
   template-matcher. **Offered to the user; not yet decided.**
2. **Booth / part names** are blank by design (section 2). Filling them needs
   either reimplementing the `get-publish-part-list` encryption or OCR-ing the
   part PDF header. Not decided.
3. **Scope expansion.** BBMP Central / North / South are separate district codes
   `S1031` / `S1032` / `S1033` — **+21 ACs, +5,654 parts** — and are *not*
   included in `S1034`. A user searching a BBMP EPIC today would fall outside
   coverage. Flagged; not decided.
4. **Hosting.** GitHub Pages caps at 1 GB; `scripts/4-upload-r2.mjs` exists for
   Cloudflare R2 if the bucket data outgrows that.
5. **Site wording** should be reviewed so district-only coverage cannot produce a
   misleading verdict for an out-of-district EPIC.
6. The user once typed **"claude rc"** — never clarified, never actioned.

---

## 8. Known-good test data

- Example record: EPIC **`NMD4011391`**, name ಗೌತಮ್ ಗಣೇಶ್ ಎಂ ಹೆಚ್, **AC 196,
  part 227**. This is the calibration record the OCR was validated against.
- Lookup smoke test: **`AAH4480430`** -> AC 177, part 3, serial 1.

---

## 9. PDF freshness — checked 2026-08-25, revisit if ECI republishes

The part URL (`scripts/1-discover.mjs` / `scripts/2-extract.py`) hardcodes
`Revision1` in the path:
`.../sir-draftroll/<ac>/2026-EROLLGEN-S10-<ac>-SIR-DraftRoll-Revision1-KAN-<part>-WI.pdf`

Checked directly against the CDN on 2026-08-25 across 7 ACs spread across
districts (1, 100, 150, 153, 175, 199, 224):
- Every part returns **`Last-Modified: Mon, 24 Aug 2026`** — the whole roll was
  published/updated as one batch that day, so everything extracted so far is
  current, not a stale leftover copy.
- **No `Revision2` exists** (404) and no `Revision0` either (404) —
  `Revision1` is the only revision ECI has published, so the hardcoded path is
  safe *for now*.
- Every response was `X-Cache: MISS`, `Age: 0` — these are live origin hits,
  not a stale edge-cached copy.

**The risk**: if ECI ever publishes a `Revision2`, the pipeline's hardcoded
`Revision1` URL will keep returning `200 OK` with the now-stale file — nothing
will error, so this would fail silently. There is currently no freshness check
built into the pipeline to catch that.

**Deferred, not forgotten** (explicit user decision, 2026-08-25): add a
periodic `Revision2`-existence probe (`HEAD` on the same path with
`Revision2` substituted, for a small AC sample) to the verification loop, so
a real ECI revision would surface automatically instead of requiring someone
to think to re-check by hand. Not yet implemented — pick this up if revisiting
verification tooling, or if EPIC lookups ever start looking suspicious for
reasons unexplained by the known OCR-geometry bug (section 4g — fixed
2026-08-29, this note is now historical).

---

## 10. Session 2026-08-30 — 100% coverage, CEO cross-check, ASD feature underway

**Draft roll reached 100% coverage** — all 224 ACs, 60,923 parts, ~44.4M
electors. `2-extract-forever.mjs` exited cleanly on its own ("Nothing left in
the current manifest") once the last stragglers (5 Belagavi parts that had
been sitting near the tail of the job queue for hours, not stuck — see below)
went through. The site's `builtAt` and GitHub Pages both confirmed caught up
by ~10:16 IST.

### The 5 "stuck" Belagavi parts were never actually stuck

AC1/214, AC8/256, AC12/9, AC12/20, AC13/275 sat unfinished for hours while
extraction visibly progressed through Tumkur and Mysore, which look like
higher AC numbers. **Root cause: `cache/manifest.json`'s `constituencies`
array is not sorted by AC number** — these five were re-appended late (an
earlier `1-discover.mjs --district` re-run), landing at positions 206-219 of
224, genuinely behind Tumkur (position 191). Confirmed by running each job
standalone outside the worker pool (all 5 completed fine, one took 137s due
to a slow CDN retry — the 120s default tool timeout made that look like a
hang when it very much was not). **Lesson**: job queue order in this pipeline
follows manifest array order, not AC number — do not assume "lower AC number
= earlier in queue" when diagnosing a similar stall again.

### Full statewide sweep — `scripts/8-full-sweep.mjs`

A new test, distinct from `7-verify.mjs`'s per-AC spot checks: one random
booth + one random sample from **every** constituency in a single run, plus
four corner-case sections — approximate-serial rows actually carry the
published flag, malformed-EPIC rows are genuinely absent (not just OCR-
flagged), duplicate EPICs resolve to exactly one live record, and the lowest/
highest-numbered AC get pushed harder (both ends of their booth range). Gated
on 100% coverage by default (`--force` to smoke-test early); everything
randomized fresh per run, no fixed seed.

Hit the same Node/Windows bug `7-verify.mjs` already documents and works
around: calling `process.exit()` while fetch's keep-alive sockets are open
crashes with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`. Fixed
identically — set `process.exitCode` and let the event loop drain, never call
`process.exit()` directly, anywhere in this script.

Also hit, and this is worth remembering for the next "why isn't the site
showing X": **a landed `git push` is not the same as GitHub Pages serving
it.** Twice this session the local build, the commit, and `origin/main` were
all confirmed correct while the live site still served the previous build for
several minutes. `gh api repos/<owner>/<repo>/pages/builds/latest` and
`gh run list` (look for the `pages-build-deployment` / `Deploy site` workflow
runs) show the real state — `in_progress` means genuinely still building, not
a bug. Don't diagnose a "stale site" as a data problem until Pages itself
confirms deployed.

### CEO official numbers — cross-checked and now shown in the UI

Fetched the CEO's official 28.08.2026 press note (`ceo.karnataka.gov.in` →
Press Releases → `Press Note - 28.08.2026.pdf`) via `WebSearch`/`WebFetch`,
extracted Annexure-1's district-wise elector table with PyMuPDF (scanned PDF,
`page.get_text()` on the raw fetched bytes — not the roll's OCR pipeline).
Statewide total **4,46,35,948**, matching section 4g's figure exactly.

Computed per-district offset against our own numbers: **99.42% overall**,
every district in a tight **97.6%-99.8%** band, no outliers — a real
improvement over the 94.8-95.4% band section 4g measured before its two
fixes shipped. Shipped as a UI feature (commit `4281077`): the district table
gained "CEO official" and "vs. official" columns, plus a footer line and an
explanatory note (the gap is genuinely-unreadable EPICs withheld rather than
guessed, not a coverage bug). CEO figures are a **hard-coded snapshot** in
`docs/app.js` (`CEO_OFFICIAL_ELECTORS`), not fetched live — they won't move
as more of the roll is verified, only this site's own count will.

**Open task, explicitly deferred**: investigate *why* the remaining ~0.6% gap
exists (genuinely unreadable source pages vs. some fixable extraction gap).
**Explicit user constraint if a fixable cause is found**: patch it and
re-pull only the specific affected booths — no full rebuild, nothing existing
gets deleted or disturbed.

### ASD ("uncollectable elector") feature — build underway

Implementing the feature `OBSERVATIONS-ASD.md` designed. **User decision made
this session, overriding that document's open item**: include elector name
and relative name in the ASD schema (breaks from the roll's own "no names"
stance — the privacy copy will need updating before the UI ships). **Explicit
storage requirement**: fully separate from the draft roll at every layer —
`cache/asd-rows/` / `cache/asd-done/` (not `cache/rows/` / `cache/done/`),
`docs/data-asd/` with its **own** `manifest.json` (deliberately *not* folding
`asdCoverage` fields into the existing `docs/data/manifest.json` as that
document suggested — full separation was judged safer and removes any risk of
racing the roll's own publish loop on one shared file). **Note the path is
`docs/data-asd`, a sibling of `docs/data`, not `docs/data/asd`, a child of
it** — it started as a child and was moved after realizing `3-build-data.mjs`
runs `rm(docs/data, {recursive:true})` on every full rebuild (a real,
periodic event — see the checkpoint-mismatch incident above), which would
have silently deleted the whole ASD tree the next time that fired. Caught
before it could happen, not after.

Built and validated:

- **`scripts/ocr/asd_parser.py`** — rule-derived table extraction from
  `page.get_drawings()` (cluster into vertical/horizontal rules, bin words
  into cells, sort by `(round(cy,1), x0)`), exactly per the observations
  document's hard-won lessons: process pool only (PyMuPDF is not
  thread-safe), never `page.find_tables()`, EPIC column joined by string
  concatenation only (never parsed as int first — loses leading zeros),
  widened EPIC grammar `[A-Z]{3}[0-9]{7,8}` for AC174's real 11-character
  series, validate-never-coerce since this text layer is exact.
- **`scripts/9-extract-asd.py`** — process-pool fetch/extract shell around
  the parser, mirrors `2-extract.py`'s resume-by-ledger design. A 404 is
  handled as a genuine zero-row successful read (that booth had no
  uncollectable electors), distinct from a real fetch failure that gets
  retried — never touches any draft-roll cache path.
- **`scripts/10-build-asd-data.mjs`** — full-rebuild-only (the ~12M-row ASD
  dataset doesn't need `3-build-data.mjs`'s incremental-checkpoint
  machinery), writes `docs/data-asd/roll/<ab>/<cd>.json` (same bucket layout
  as the roll, for `app.js`'s binary search to reuse unchanged) and
  `docs/data-asd/manifest.json`. Row tuple:
  `[suffix, ac, part, serial, reasonCode, oldPart, oldSerial, name, relativeName]`.

**Two real bugs found and fixed during validation** (both by cross-checking
actual PDF output against the document's own expected numbers, not by
trusting the design doc at face value):

1. **Header regex silently failed.** A hand-transcribed Kannada label string
   used a different (but visually identical) conjunct-glyph sequence than
   what's actually in the AC-name/part-name header line. Fixed by matching
   *structurally* — first two lines of the page, pattern `: N - text` — never
   by matching hardcoded label text again.
2. **~5.5% of `DUPLICATE` rows silently misclassified as `OTHER`.** Same root
   cause, different spot: the vowel sign 'ೇ' has both a single precomposed
   Unicode codepoint and a base+combining-mark decomposition that render
   identically but don't compare equal as raw strings. A hand-typed reference
   string used one form; PyMuPDF's extracted text used the other. Fixed with
   `unicodedata.normalize('NFC', …)` on both the reference table and every
   lookup. **General lesson, not just this one string**: any hand-typed
   Kannada literal compared against PDF-extracted text in this codebase needs
   NFC normalization — do not assume visual identity means string equality.

Validated post-fix against 2,816 real rows across 13 parts spanning AC1/50/174
(including all 8 real 11-character EPICs in the sample): **100% EPIC grammar
validity**, reason-code mix now lands cleanly in the document's expected
4-category split with zero unexplained `OTHER`.

**Statewide extraction launched** ~15:56 IST 2026-08-30, `nohup`+`disown`
detached (confirmed via parent-chain walk — rooted at `nohup.exe`, no further
traceable ancestor), `PYTHONUNBUFFERED=1` set explicitly (Python's default
buffering otherwise leaves the log looking silent for minutes at a time when
not attached to a TTY — hit this once, fixed by restarting with the env var
set rather than waiting it out). Logs to `cache/asd-extract.log`. Sustained
~290 parts/min, 0 unreadable, ETA roughly 3-3.5h from launch — in line with
the observations document's own ~3h projection.

### ASD extraction and build finished — 100% coverage, 10,766,778 rows

Extraction finished in 84.7 minutes (well under the ~3h projection —
throughput climbed to ~713 parts/min by the end, faster than the doc's
bench figure), 60,305 parts read, 187 legitimate zero-elector booths (a 404
is data, not a failure — see the parser's own doc comment), **0 unreadable**.
Build followed cleanly: 65,536 buckets, 10,766,778 rows published, 100.0%
coverage across all 224 constituencies, 463 duplicate EPICs skipped, 30 rows
withheld. Committed (`8268e005d0a`) and pushed.

**All 30 withheld rows manually traced back to the source PDF** — none are a
parsing bug, all are genuine source-document properties:

- **~19 rows: legacy out-of-state EPIC formats** (`OR/19/117/328070`,
  `HR/02/20/069872`, `WB/10/063/552354`, `UP/56/275/0252577`, …) — voters who
  shifted from another state, still carrying that state's pre-standardization
  ID format. Rendered one at 400 DPI and confirmed it's exactly what's
  printed — a real ID, just not the national 3-letter+7-digit grammar.
- **8 rows: a font-encoding defect in the source PDF itself**, all sharing
  the identical corrupted prefix `ŸÑÜ`, concentrated in AC157/158/159 (one
  district, likely one report-generation batch). Rendered the actual glyphs
  and compared against a clean neighboring EPIC using the identical font on
  the same page: **the corruption is in the rendered pixels, not just the
  extracted text** — even a human reading the printed page sees the same
  garbled characters. Nothing to recover; this is ECI's own PDF, broken at
  the source.
- **3 rows: genuine source-data errors** — two pure-numeric legacy
  enrollment IDs with no letters at all (`321399`, `288088`, both very old
  `DEAD` entries — pre-EPIC-era voters who never got a modern card), and one
  literal place name (`CHANDAPURA`) typed into the EPIC column, a real BLO
  data-entry mistake. All confirmed by rendering, not assumed.

These electors are not erased — name, reason, and old part/serial are still
in `cache/asd-rows/`, just not published to the hash-bucket index since
there is no valid EPIC to bucket them under (the site's search is
EPIC-keyed by design). A fallback "known unmatched entries" list was
offered and **declined by the user** — noting it here in case it's wanted
later, not building it now.

### The full statewide overlap audit found real collisions — 3,191 of them

`13-overlap-audit.mjs` (new this session) checked **every** shared bucket
between the two published trees — not a sample. Both trees share shard
depth 4 / suffix length 8 (verified, not assumed), so the same SHA-256(EPIC)
lands in the identically-pathed bucket file in both, which made an exhaustive
check cheap: read each bucket pair once, merge-compare the two sorted suffix
arrays.

**Result: 3,191 EPICs genuinely appear on both lists**, out of 44,385,222
roll electors and 10,766,778 ASD rows. This contradicts the small-sample
assumption both this session and `OBSERVATIONS-ASD.md` §5 made (0/1,400 and
0/33,127 respectively) — not because either sample was run wrong, but
because the true rate (~0.007% of roll electors) is genuinely too low for a
few-thousand-row sample to reliably surface. Do not trust a sampled overlap
check to mean "zero exists" again; only an exhaustive one can say that.

Breakdown (recovered actual EPICs by re-hashing `cache/rows` +
`cache/asd-rows` against the 3,191 colliding suffixes):

| | count | share |
|---|---|---|
| reason: SHIFTED | 2,414 | 75.7% |
| reason: ABSENT | 596 | 18.7% |
| reason: DUPLICATE | 149 | 4.7% |
| reason: DEAD | 32 | 1.0% |
| same AC on both sides | 123 | 3.9% |
| different AC on each side | 3,068 | 96.1% |

The 96.1% different-AC figure matches `OBSERVATIONS-ASD.md` §5a's "timing
skew" mechanism exactly: someone shifted, was recorded as such on their old
AC's ASD report, and is now on a *different* AC's current roll — both true
at once, not a data error. The 149 DUPLICATE-reason rows are the other
predicted mechanism confirmed directly: the BLO's assertion "already
registered elsewhere" checked out as literally true.

**The 32 DEAD-reason collisions are the sensitive case verdict 3's wording
was written for** — an EPIC a BLO recorded as belonging to a deceased person,
that still appears on the current live roll. This is exactly why that
verdict states a disagreement between two sources rather than picking one as
authoritative (see the UI section above) — confirmed necessary by real data,
not a hypothetical.

Full result set (3,191 rows) persisted to `test-logs/test-log.jsonl` with
`layer: "overlap-audit"` — see the log book section immediately below.

### A real bug in the audit's own EPIC-attribution — found by the user, fixed, verified

**Found by manual verification, not by this project's own checks.** The user
spot-checked one reported example (`YYV0007401`, a DEAD-reason collision)
against the live site and reported it didn't look right. Investigated and
that *specific* EPIC turned out to be genuinely correct on every layer
checked (`cache/rows`, `cache/asd-rows`, both published buckets, and a live
replica of the site's own lookup) — but tracing it surfaced a **real bug
elsewhere** in `13-overlap-audit.mjs`'s EPIC-recovery step:

```js
const bySuffix = new Map(collisions.map((c) => [c.suffix, c]));   // BUG: suffix only
```

The recovery phase re-hashes all ~55M rows (`cache/rows` + `cache/asd-rows`)
to find which EPIC produced each of the 3,191 collision addresses, but was
matching on the 32-bit **suffix alone**, never checking the 16-bit prefix.
Across 55M rows against 3,191 target suffixes, that gives an expected **~41
false attributions** by pure chance (55,000,000 &times; 3,191 / 2&sup3;&sup2;
&asymp; 41) — the underlying bucket-level collision (found via the
merge-compare step, which *does* use the full bucket address) was never
wrong, only some of the human-readable EPIC strings attached to them.

**Fixed**: collisions now carry their bucket's `prefix` alongside `suffix`,
and the recovery scan matches on both together
(`` `${prefix}:${suffix}` ``). Re-ran the full exhaustive audit with the fix.

**Result confirmed by diffing old vs. new `test-logs/test-log.jsonl`
entries**: exactly **10 of the 3,191 collisions had their attributed EPIC
change**. The bucket-level collision *count* (3,191) did not change — only
10 of the EPIC labels did. **Manually re-verified 2 of the 10 corrected
entries directly against `cache/rows`/`cache/asd-rows`** (not just re-running
the script again): both post-fix EPICs matched the cache files exactly;
both pre-fix EPICs did not. Example: collision at roll AC156/part107/serial306
— old (wrong) attribution `RSB4744439`, new (confirmed correct) attribution
`ICP4301362`, verified directly against `cache/rows/156.jsonl`.

`reports/overlap-audit-2026-08-30.pdf` regenerated from the corrected data
(81 pages now, was 80) with an explicit revision note at the top explaining
what changed and why, rather than silently replacing the file. Pushed.

**Lesson for future report-generation work in this codebase**: re-hashing a
large row set to recover a label for a small set of target hashes needs the
*full* address (every hex segment used for bucketing), not just the part
that happens to be convenient to compare. This is the second time this
project has found a bug from a suffix/segment being treated as sufficiently
unique when it wasn't at large-N scale (the first was the JS heap ceiling
issue at ~36M rows, a different mechanism but the same underlying lesson:
assumptions that hold at small scale silently stop holding at this dataset's
actual size).

### A second, independent, more serious finding: OCR misreads that pass every check

**Also found by manual user verification**, same session, different part of
the pipeline: `INA8000960` (published, `ok:true` — fully confirmed by the
pipeline's own accuracy layers) is actually `INA1800960` on the source PDF
(AC112, part 202, serial 476). Confirmed by rendering the actual page at
high DPI and reading the card directly.

**Root cause is not the crop.** Isolating this exact card's EPIC crop and
OCR'ing it *alone* (outside the production pipeline's batching) reads it as
`INA1I800960` — an 11-character string with the same "spurious glyph at the
letter/digit boundary" pattern `coerce_epic()`'s own docstring already
documents (`'TDB0917013'` read as `'TDBO0917013'`). Applying the pipeline's
own existing `coerce_epic()` to *that* isolated reading correctly produces
`INA1800960` — the true value.

**But the real pipeline doesn't OCR one card at a time.** For speed
(~10x, per the README's own measurement — 0.9s for a 30-card contact sheet
vs 9.6s for 30 separate Tesseract calls), all 30 cards on a page are stacked
into one tall image and read in a single Tesseract pass. In that batched
context, this same card reads as `INA8000960` directly — a *different,
worse* misread that happens to already be exactly 10 characters, so the
11-char spurious-glyph fixer never triggers. It is silently, confidently
wrong rather than silently uncertain.

**This is a materially different problem from everything found so far**:
- The crop-geometry bug (section 4g/4h) produced a hard crash or an
  obviously-invalid string — caught by validation.
- The malformed-EPIC withholding (the CEO-gap work, in progress when this
  was found) produces `ok:false` — flagged, not published as confirmed.
- **This produces a `ok:true`, grammatically valid, wrong EPIC** — invisible
  to geometry checks, grammar checks, the serial-sequence fit, and every
  "verify" script that has run so far, because those all re-run the *same*
  batched pipeline and get the *same* wrong answer both times. Re-OCR-ing
  the same image with the same method is not independent verification of
  accuracy — only of reproducibility.

**Deterministic, not a rare glitch**: re-ran extraction on this exact PDF
twice and got `INA8000960` both times.

**Status, updated 2026-08-31: scope now measured on a large statewide
sample. See the two subsections immediately below** — the batch-size theory
of the fix turned out not to hold, and the true confirmed rate (manually
verified against source pixels, not just re-OCR agreement) is lower than
the raw automated-candidate rate but still real and statewide.

**Related, found the same session while investigating the CEO gap**:
`ROLL_OCR_RETRY` (an opt-in second-pass re-read for EPICs that *fail
grammar*) is off by default, based on a code comment claiming Karnataka's
200 DPI renders read "100%" on the first pass — contradicted directly by
production data (0.42% genuinely withheld, 187,142 rows). Tested on 4 real
parts: 3 of 4 previously-malformed EPICs were fully recovered into valid
EPICs with the retry enabled (`NUV200268`&rarr;`NUV2002681`,
`NUV202842`&rarr;`NUV2028421`, an empty read&rarr;`NUV4241303`). This retry
only fires for EPICs that already **fail** grammar, so it would **not** have
caught the `INA8000960` case above (which passes grammar) — the two findings
are related (both trace back to contact-sheet OCR degradation) but need
separate fixes.

### Batch-size experiment — 2026-08-30/31, "just shrink the contact sheet" does not fix it

Before measuring scope, tested the obvious candidate fix directly: re-OCR
the two known-bad cards (`INA8000960` and a second pair found during this
step, `AC218/part281/serial786+713`, both wrongly flagged — see below) at
contact-sheet batch sizes 1, 2, 3, 5, 10, 15, 30 (production uses ~30, one
full page). Result (`scripts/ocr/_experiment_batch_size.py`, not committed
— throwaway):

- `INA8000960`/`INA1800960`: **wrong at every batch size tested, including
  1.** Batch size is not the cause for this card — Tesseract misreads this
  specific glyph combination regardless of how much context surrounds it.
- The AC218 pair: **correct at sizes 5–30 (matches production), wrong at
  sizes 1–3.** For this card, the production batch size is fine and
  isolating too aggressively is what breaks it — the opposite direction.

**Conclusion: there is no single batch-size change that is a safe global
fix.** It would fix some cards and break others that are currently correct.
Isolating a single card is not a reliable "ground truth" oracle either — it
has its own failure mode, distinct from and not obviously better than
batching's. This also surfaced real Tesseract non-determinism: the same
`INA8000960` crop, same method, gave three different wrong readings across
attempts in this session. No single re-OCR, run once or repeated, is a
verdict — only a candidate worth a human pixel-check.

### Scope measurement — 2026-08-31, 120 parts / 1,800 cards statewide, manually verified

`scripts/ocr/measure_batching_error.py` (committed): samples parts spread
across the whole state, and for a fixed number of cards per part (15, chosen
for tractability — isolating a card forfeits contact-sheet's ~10x speedup),
compares the production batched read against an isolated re-read of the same
crop. Every disagreement is a **candidate only** — both the docstring and
the code are explicit that isolation itself is unreliable (per the
experiment above), so nothing is counted as confirmed without a human
looking at the actual crop pixels. Every candidate's crop image is saved to
`cache/ocr-batching-candidates/` (gitignored, local only) specifically for
that review step.

Run: `--parts 120 --cards-per-part 15 --seed 42`, ~2.5h detached
(`nohup ... & disown`, verified parented to `nohup.exe`, survives the
session). Result: **1,800 cards sampled, 0 fetch/align failures.**

- 23 raw `SILENT_MISMATCH_CANDIDATE` (batched and isolated both grammar-valid,
  disagree) — 1.28% of sampled cards.
- 88 raw `RETRY_RECOVERABLE_CANDIDATE` (batched fails grammar, isolated
  recovers a valid EPIC) — the already-documented `ROLL_OCR_RETRY` finding,
  a separate bug; not manually reviewed this round, already independently
  measured earlier (~75-80% recovery on a small sample).
- 1,683 agreements, 6 both-unreadable.

**All 23 `SILENT_MISMATCH_CANDIDATE`s were manually reviewed against the
actual crop pixels** (8x-upscaled labeled composite sheets, see
`test-logs/test-log.jsonl` layer `ocr-batching-check-manual-review` for the
full per-card record — `expected` is the manually-read true EPIC, `verdict`
is `CONFIRMED_SILENT_MISREAD` or `FALSE_POSITIVE_CANDIDATE`). Result:

- **15 of 23 confirmed**: the published `ok:true` EPIC is genuinely wrong.
  Some are clean single-glyph confusions (`WZZ...`→true `WZU...`); at least
  one is a serious digit-order scramble, not just a letter swap
  (`YYV9231557` published, true `YYV4923157`, AC106/part143/serial292;
  similarly `AQH7841112` published vs true `AOH4784112`, AC219/part43/serial102).
  In 4 of the 15, **neither** the published value nor the isolated
  "candidate correction" was actually right (e.g. AC207/part45/serial433:
  published `ULL2335156`, isolated `UIL2335156`, true `UII2335156`) — the
  isolated read is useful for *flagging* a card as wrong, not for
  automatically supplying the fix.
- **8 of 23 false positives**: the published batched value was correct all
  along; isolating the crop hallucinated the disagreement (same failure
  mode as the batch-size experiment's AC218 case above).

**Confirmed rate: 15/1800 = 0.83% of sampled cards** — lower than the raw
1.28% candidate rate, but real, and not evenly spread. All 15 confirmed
misreads came from only **7 of the 120 sampled parts**
(AC207/part45, AC161/part138, AC39/part166, AC161/part203, AC219/part43,
AC191/part150, AC106/part143) — the remaining 113 parts had zero confirmed
issues among their 15 sampled cards each. Within a "bad" part the local
rate is much higher than the statewide average (AC219/part43: 4 of 15
sampled cards confirmed wrong = 27%). This looks like a **per-part/per-PDF
scan-or-font-quality effect** (each bad part repeats the *same* letter-pair
confusion across its own multiple confirmed cards — AC161 confuses Z↔U
repeatedly, AC219/AC191 confuse O↔Q↔V repeatedly, AC207 confuses I↔L
repeatedly), not a uniform per-card error rate — worth investigating
whether "bad" parts correlate with a specific district, print batch, or
scan date before assuming 0.83% applies evenly statewide.

Extrapolated naively (0.83% × ~44M published rows) that is on the order of
**~365,000 rows** — almost certainly an overestimate given the clustering
just described (a handful of genuinely bad-quality source PDFs, not a flat
per-card rate), but not a number to wave away either.

**Not yet done, still open:**
- No fix identified yet beyond "shrinking the batch size" (ruled out
  above). Possible directions not yet tried: a *third* independent re-read
  method (different psm, different upscale) requiring 2-of-3 agreement
  before accepting a change; identifying what specifically makes a part
  "bad" (scan quality metric?) and targeting only those; accepting the
  withhold-rather-than-guess tradeoff for specific ambiguous letter pairs
  per part.
- No republish has happened for any of these 15 confirmed-wrong EPICs.
  `3-build-data.mjs`'s incremental-build checkpoint is row-count-based (new
  *appended* rows only) — it does not have a mechanism yet for correcting
  an already-published row in place. That needs a small, separate patch
  script (unhash the wrong EPIC's bucket entry, hash-and-insert the
  correct one) — straightforward, but not built, and there's no point
  building it until the fix strategy above is decided.
- **Deep-dive into what makes the 7 "bad" parts different — 2026-08-31,
  inconclusive.** Checked district clustering (weak: only B.B.M.P(NORTH)
  repeats, 2 of its 9 sampled parts, not much above the 7/120 base rate),
  cards-per-part (bad avg 783 vs all-120 avg 730 — barely elevated), and
  whole-page image quality metrics fetched for all 7 bad parts plus a
  12-part control sample with zero flagged issues
  (`scripts/ocr/_quality_probe.py`, not committed — throwaway). Findings:
  - **Image resolution is identical across all 19 parts checked**
    (1983x2806) — every Karnataka part renders at the same fixed DPI, ruled
    out entirely.
  - JPEG compression (bytes/megapixel) and sharpness (Laplacian variance)
    are both slightly higher for bad parts (+3.4% and +3.9% respectively)
    but the ranges overlap heavily (one control part scores higher than 5
    of 7 bad parts) — not a reliable discriminator at this sample size.
  - **The real signature is glyph-specific, not page-level**: each bad part
    repeats one *specific* letter-pair confusion across its own confirmed
    misreads (AC161: Z↔U; AC219/AC191: O↔Q↔V; AC207: I↔L) — localized to a
    handful of cards out of 700-900 per part, which a whole-page average
    necessarily dilutes away. Not yet explained further; would need
    pixel-level comparison of that specific glyph pair's rendering across
    parts, or PDF producer/creation-date metadata to check for a shared
    print/scan batch — neither attempted yet.

- **Root cause found — 2026-08-31, "shared EPIC prefix + per-instance glyph
  confusion," not a per-part scan-quality effect.** Pulled every non-flagged
  card from AC161/part138 and AC161/part203 (both flagged for a Z/U
  confusion) whose EPIC's 3rd letter was Z or U — 9 such cards, none in the
  original 15-card sample. All 9 visually confirmed the true letter is "U",
  regardless of whether the batched OCR read it as U (correct) or Z (wrong)
  — the identical glyph shape, read two different ways card to card, in the
  same part, same font, same everything. Quantified via
  `roll_ocr.read_part_bytes`'s own prefix distribution for these two parts:
  `WZ?` accounts for 85% of part138 (565/662) and 75% of part203 (467/620)
  — i.e. "WZU" is that AC's dominant, locally shared EPIC-issuance prefix —
  and within it, `WZZ` (wrong) appears 29.9% and 25.9% of the time
  respectively, with **zero** other variants (`other=0` both times: it is
  never WZX, WZQ, anything else — a clean, isolated, two-way confusion).
  Checked statewide against the 42.4M already-extracted `ok:true` rows in
  `cache/rows/`: **115,939 rows carry this exact WZU/WZZ prefix pair,
  28,703 of them (24.8%) read as the minority `WZZ`** — on the strength of
  the 9-for-9 visual confirmation, essentially all of those 28,703 are very
  likely genuinely wrong. That is **one specific, well-understood glyph
  confusion accounting for roughly 28,700 wrong EPICs on its own** — far
  more than the 15-per-1800-sample-cards headline number could show, because
  that sample only ever looked at 15 cards out of each part regardless of
  how many actually shared the hard prefix.

  **This also explains the earlier inconclusive results**: it is not a
  page-level scan-quality effect (ruled out by whole-page metrics already),
  not a print-batch effect (PDF metadata is empty on every file checked,
  every one of 19 parts, both bad and control — ECI's CDN strips producer/
  creator/dates entirely), and not something batch-size-related (already
  ruled out). It is a **per-instance Tesseract font-glyph ambiguity on
  specific letter shapes** (here, U vs Z at this exact font/DPI), and a
  "bad" part in the original sample is simply a part where many voters
  happen to share a local EPIC prefix that contains one of these hard
  letters — more at-bats for the same coin-flip, not a worse scan.

  **Caution — do not over-extrapolate to the other letter pairs found**:
  `WZU`/`WZZ` is uniquely clean because both statewide counts sit on the
  same side of a genuine minority/majority split for what is almost
  certainly one real prefix. The other confusions found during manual
  review (AOH/AQH in AC219, UII/ULL/UIL in AC207, AOV/AQO/AQV in AC191) do
  **not** have this property statewide — e.g. `AQH` (146,398 rows) is far
  *more* common than `AOH` (8,770) in the full 42.4M-row dataset, the
  opposite of what AC219/part43's local pixels showed. That almost
  certainly means AOH and AQH are both genuinely real prefixes used by
  *different* constituencies' issuing offices, not one uniformly misread as
  the other — the manual pixel confirmation for those pairs only applies to
  the specific cards checked in AC207/AC219/AC191, not the statewide
  population. Any fix must be scoped locally (per part or per AC), not
  applied as a blanket statewide substitution table.

  **A concrete, well-justified fix candidate this suggests** (not built,
  needs the user's go-ahead first): a **prefix-consensus repair**, in the
  same spirit as `repair_serials()`'s existing sequence-fit consensus for
  serial numbers — within a single part (or AC), if one 3-letter prefix
  dominates overwhelmingly (as WZU does at 70-74% of all WZ? cards), any
  reading that differs from it by exactly one character is very likely a
  misread of the dominant prefix and can be corrected with high confidence.
  Scoped locally, this avoids the AOH/AQH trap above (different regions
  keep their own genuinely-different dominant prefixes). Not yet measured
  how many of the ~44M rows this would actually touch beyond the WZU/WZZ
  case, and no patch/republish mechanism exists yet either (see the
  existing note below on `3-build-data.mjs`'s incremental path not
  handling in-place correction).

- **Statewide scope check — 2026-08-31, before building anything.** User
  asked to check how many other ACs show the WZU/WZZ pattern before
  building a fix. Ran a per-AC analysis over all 42.4M `cache/rows` (no
  fetching needed, already local): for every AC and every letter position,
  grouped prefixes by their other two fixed positions and looked for
  positions where **exactly two** distinct letters ever appear — the same
  "other=0" signature WZU/WZZ had — with a material, meaningfully-skewed
  minority (≥50 rows, 3-45% share). 188 such statistically-clean binary
  splits exist across 224 ACs. Most trace back to ACs already known to be
  tangled multi-prefix situations (AC191, AC207, AC219, and newly AC6 and
  AC115 show the same pattern — 3+ genuinely different real prefixes
  sharing two fixed positions, not a true binary — visible because the same
  AC produces multiple overlapping candidate entries at different wildcard
  positions). Filtering to ACs with **exactly one** candidate entry (not
  part of a tangled cluster) leaves **10 genuinely isolated candidates**:
  AC25, AC41, AC78, AC107, AC155, AC161 (already confirmed), AC168, AC171,
  AC173, AC190.

  **Pixel-checked two of the new ones — a 1-for-2 hit rate, even among the
  cleanest-looking candidates:**
  - **AC41 (FZT dominant / FZI minority, 5,052 minority rows): CONFIRMED
    real.** AC41/part11/serial281's crop clearly reads `FZT3287976`,
    published as `FZI3287976`. Notably, this specific part had *zero* FZT
    rows at all (all locally misread as FZI), unlike WZU/WZZ's dense
    per-card mixing within the same part — worth keeping in mind before
    assuming every case behaves like WZU/WZZ did.
  - **AC190 (GLV dominant / GYV minority, 3,621 minority rows): REFUTED.**
    Both checked GYV cards (AC190/part16/serial3 and serial891) crop-match
    their published value exactly — GYV is a real, distinct, correctly-read
    prefix, not a misread of GLV.

  **Conclusion: no candidate — however clean its statistics look — can be
  trusted without individual manual pixel verification.** A blanket,
  purely-statistical "dominant prefix wins" auto-fixer would have wrongly
  overwritten every correct GYV row in AC190. Any prefix-consensus repair
  needs a verification step per candidate pair (a small manual or
  semi-automated pixel sample, same rigor used throughout this
  investigation), not a rule applied automatically off the statistics
  alone. The remaining 8 isolated candidates (AC25, AC78, AC107, AC155,
  AC168, AC171, AC173) are not yet checked; magnitudes are mostly small
  (a few hundred to ~1,900 rows) except none approach WZU/WZZ's 28,700.
  **WZU/WZZ remains the only case confirmed at real statewide scale.**

- **Larger statistical sample — 2026-08-31, 135 more cards, zero exceptions.**
  User asked how much effort a full pixel-by-pixel verification would cost;
  answer was that exhaustively checking all 28,703 WZZ rows isn't feasible
  or necessary — a large enough consistent sample is the same tool
  `repair_serials()` already relies on. Ran a bigger sample: 15 more AC161
  parts (beyond the 138/203 already checked), ~6 WZZ + 3 WZU per part,
  ~1-2 min per part fetch, reviewed via 23 labeled 6-per-sheet composite
  images rather than one image per card. **Result: 90/90 WZZ cards
  confirmed true letter U (misread), 45/45 WZU cards confirmed correct —
  zero exceptions.** Combined with the original 9, that is **144 cards
  checked across 17 different AC161 parts, 100% consistent.** This is now
  strong enough evidence to build a fix on for AC161 specifically; the
  other 8 isolated candidates outside AC161 (see above) remain unverified
  at this sample size and should not be assumed to behave the same way —
  AC190's GLV/GYV pair already showed the opposite (minority was correct).

- A GitHub Actions + Tailscale-home-exit-node trial was scoped
  (`.github/workflows/probe-cdn-vpn.yml`) to test whether hosted-runner
  compute could speed up a larger version of this measurement, since
  every hosted-runner IP range is otherwise flat-blocked by this CDN (see
  section 5). **User abandoned this before the tailnet-side setup was
  done** — workflow file was added then removed the same session, nothing
  ever ran. Local-only extraction remains the only active path.

### AC161 WZU/WZZ fix applied, verified twice, and exhaustively live-tested — 2026-08-31

Full remediation cycle for the one root cause confirmed at real scale
(above): 27,865 rows corrected (`scripts/fix-ac161-wzu-wzz.mjs`), touching
37,646 published bucket files. Three independent checks, not just the fix
script's own tally:

1. **`scripts/verify-ac161-fix.mjs`** — extracted the pre-fix `docs/data`
   tree from git HEAD, diffed every touched bucket file byte-for-byte.
   **25,483,869 untouched (non-corrected) records checked, zero unexpected
   changes** — confirms nothing outside the intended AC161 corrections was
   touched anywhere, including every other AC's data sharing those bucket
   files.
2. **`scripts/verify-ac161-live.mjs`** — exhaustive check of all 27,865
   corrections against the *actually-deployed* GitHub Pages site (not just
   local files), with automatic retry of transient fetch failures until
   full coverage. Found **one genuine anomaly**: AC161/part79/serial276's
   corrected EPIC (`WZU4244661`) is a real duplicate of an EPIC already
   published under AC181/part24/serial1158 (literal same string, not a
   hash collision) — the fix script's simple add/remove logic hadn't
   replicated `3-build-data.mjs`'s own existing duplicate policy
   ("the same EPIC can appear in two parts when a transfer is mid-flight",
   first-file-processed wins, other silently dropped). Fixed by applying
   that same policy (AC161 precedes AC181 in canonical `readdir` order, so
   AC161 wins) — removed AC181's entry, decremented electors by 1 in both
   `manifest.json` and `cache/build-state.json` (44385227 → 44385226,
   AC181 191517 → 191516). Pushed as `c9ec5372367`.
3. Final spot-check directly against the live URLs after that fix's Pages
   deploy completed — confirmed the duplicate is gone and the manifest
   electors count is correct.

**Net result: all 27,865 AC161 corrections are live, correct, and verified
at three independent layers** (local byte-for-byte diff, live-site
exhaustive fetch, live-site spot-check post-fix). This is also the first
real-world confirmation that the hash-only bucket addressing scheme's
theoretical duplicate-EPIC risk (discussed earlier re: 48-bit collision
math) is not just theoretical — worth remembering if another AC's
misreads are ever corrected the same way: **always run the exhaustive
live-site check afterward, don't assume a clean local verification is
enough**, since a genuine duplicate can only be caught by checking against
what's actually already published.

### 10,000-card statewide sample — 2026-08-31/09-01, the bug splits into two different problems

User explicitly asked (after the AC161 fix) for a much larger sample to
look for similar mismatches statewide and work toward a **generic** fix.
Ran `measure_batching_error.py --parts 400 --cards-per-part 25 --seed
1000`, detached, ~12.6 hours (rate varied a lot — long stretches at the
expected ~80s/part, but two multi-hour stalls against the CDN, cause not
investigated further since the process recovered on its own both times).

Result: **9,955 cards sampled across 399 parts** (1 part failed to fetch),
**99 raw candidates**. All 99 manually reviewed against source pixels
(labeled composite sheets, same rigor as the earlier 1,800-card round) —
**40 confirmed genuine misreads, 59 false positives** (isolation
hallucinated, same known failure mode as before). Confirmed rate: 40/9955
= 0.40%, broadly consistent with the earlier 1,800-card sample's 0.83%
given the AC161 cluster that dominated that sample is now fixed and
excluded from consideration going forward.

**The 40 confirmed cases split into two genuinely different problems, not
one bug:**

1. **Letter-pair confusion within a locally-dominant EPIC prefix** (same
   shape as WZU/WZZ) — 28 of 40 cases, across **13 different ACs**: 157
   (STZ/ITZ/SIZ/SIT), 49 (XOJ/XOO), 207 (UII/ULL/UIL/ULI, the same messy
   multi-way cluster flagged earlier — still messy, several new confirmed
   cases here too), 191 (AOV/AOQ/AQV), 5 (IEL/LIE), 6 (ZTO/ZIO/ZIT), 180
   (ZCS/ZZC), 20 (LYP/IYP), 219 (AOH/AOQ/AQH — 4 more confirmed, same
   messy cluster as before), 152 (ZBG/ZZB), 53 (YFO/YFQ), 44 (UOB/UOQ).
   One case (AC174/part245/serial209) is a **near-total misread** —
   published `HGB3352671`, true value `SVF7788144`, almost every character
   wrong, not a single-glyph confusion at all — worth remembering that
   this bug's worst cases aren't always the "one letter flipped" shape.
   AC157's own cluster (7 candidates checked, only 3 confirmed) is a good
   reminder that a part having many candidates from the same prefix
   pattern does **not** mean the pattern is real there — has to be
   checked per-AC every time, exactly like AC190's GLV/GYV false lead
   during the AC161 scoping work.
   The AC161 prefix-consensus fix approach generalizes to all of these in
   principle, but each pair needs its own verification pass first — no
   shortcut around that.

2. **Genuine digit confusions — a different, harder problem.** 11 of 40
   cases: single-digit substitutions (`WEC5574111`→`WEC0574111`,
   `AAN6670000`→`AAN0670000`, `AKB5591537`→`AKB0591537`,
   `ZWF0098611`→`ZWF5098611`, `NMD4027800`→`NMD4027900`,
   `AAN0022256`→`AAN5022256`) and digit-order scrambles
   (`WBN2526093`→`WBN2252609`, `TQH4274117`→`TQH2427417`,
   `NMD0390180`→`NMD3090180`, `AEC7888390`→`AEC3788890`,
   `RPJ0553256`→`RPJ0053256`) in the numeric portion of the EPIC.
   `coerce_epic()`'s existing translation table only fixes letter-shaped-
   as-digit confusions at the 3/7 grammar boundary — it has never handled
   genuine digit-to-digit misreads. **No consensus-based fix is possible
   here**, unlike the letter-pair case: a shared EPIC prefix lets many
   voters "vote" on what the correct local letters are, but each voter's
   own number is essentially unique, so there is no dominant value to
   fall back on. Catching these requires the same isolated-vs-batched
   comparison at full scale — which forfeits contact-sheet batching's
   ~10x speedup — so there is **no cheap generic fix for this category**
   at the time of this write-up. Worth remembering as a hard limit on how
   much this whole investigation can ultimately clean up automatically.

All 99 manual verdicts logged to `test-logs/test-log.jsonl` (layer
`ocr-batching-check-manual-review-10k`). Full candidate detail in
`cache/ocr-batching-check-10k-summary.json` and
`cache/silent-candidates-10k-reviewed.json` (both gitignored, local only —
the log book entries are the durable record).

### Test log book — new standing convention, 2026-08-30

Explicit user requirement: every verification test this project runs is now
recorded to `test-logs/test-log.jsonl` (committed to git, not `cache/`, which
is gitignored) — timestamp, EPIC, expected, actual, verdict, one JSON line
per test, appended only, never rewritten. See `test-logs/README.md` for the
full format.

- `scripts/7-verify.mjs`, `8-full-sweep.mjs`, `11-verify-asd.mjs`,
  `12-full-sweep-asd.mjs`, `13-overlap-audit.mjs` all updated to log here —
  a shared `logTest()` helper now lives in `scripts/lib/common.mjs` for
  exactly this, so future test scripts should use it too rather than
  reinventing a log format per script.
- `scripts/16-commit-test-log.mjs` — a small supervisor loop (same shape as
  `6-auto-publish.mjs`) that commits + pushes `test-logs/` on an interval
  (default 10 min) so a long-running sweep's results are never more than one
  interval from being safely on `origin/main`. Running detached
  (`nohup`+`disown`) as of this write-up.

### Exhaustive per-booth sweep — built, ASD paused mid-run, roll still deferred

`scripts/14-exhaustive-sweep.mjs` — every booth (not one per AC), both
datasets, both layers (live-site + source-PDF), logging every test to the
book above. `--samples` defaults to **1** per booth (scaled down from an
initial request of 5 once the roll dataset's realistic cost was measured —
**note this does not change the roll dataset's ~4-day estimate**, since a
booth's PDF is fetched once regardless of sample count and that fetch is the
actual bottleneck, not the sample count).

**Found and fixed a real concurrency bug in this script while it ran**:
`spawnSync` for the Python re-check call was blocking Node's entire
single-threaded event loop, silently serializing every `pool()` worker
behind whichever one held it. Measured ~52-55 booths/min before the fix,
~216-232/min immediately after on a 50-booth smoke test at the same
`--concurrency 10`. Fixed with a `spawnAsync()` Promise wrapper around
`child_process.spawn` (same `{status, stdout, stderr}` shape as `spawnSync`,
so nothing else needed to change) — committed as `a33a1cb93c3`. Once the
full run resumed at scale, throughput settled lower again (~75-78/min,
likely the ECI CDN's own aggregate throttling reasserting itself under
sustained load — the same ceiling section 4e already documents for the roll
dataset, not a regression of this fix).

**Status as of this write-up: PAUSED, not finished, explicitly by user
request** (to free the machine for the CEO-gap investigation below).
**1,661 of 60,923 ASD booths done**, 0 site-layer fails, 0 pdf-layer fails
so far. Fully resumable — the done-ledger (`cache/exhaustive-done-asd.txt`)
already has all 1,661 recorded, and every test up to this point is already
in `test-logs/test-log.jsonl`. **To resume exactly where this left off**:

```
node scripts/14-exhaustive-sweep.mjs --dataset asd --concurrency 10
```

run detached (`nohup ... & disown`) as before — it will report "N already
done from a prior run" and pick up the remaining ~59,262 booths in a fresh
random order. The periodic committer
(`node scripts/16-commit-test-log.mjs --interval 600`) was left running
throughout the pause, so nothing further needs restarting on that front.

The roll dataset (~4 days, CDN-bound) remains **not started**, per the
same standing instruction as before — do not start it without being asked.

### Task pipeline as of this write-up (for continuity if picked up cold)

Done:
1. Full statewide sweep test of the draft roll (`8-full-sweep.mjs`) — ran to
   completion (~2.5h). **Section A: 224/224 swept, 0 site mismatches** — the
   published data itself is clean. The 64 "failures" reported were all
   `PDF fetch failed twice: terminated` — CDN-side connection resets, not
   data errors, almost certainly from running concurrently with the ASD
   extraction's own 11-worker load on the same CDN for most of that window.
   Section B corner cases all clean (20/20, 20/20, 20/20, 8/8). Worth a clean
   re-run of just the PDF-recheck portion once nothing else is hammering the
   CDN, but not urgent — this is a network-flakiness question, not a data one.
2. ASD extraction — complete, 10,766,778 rows, 0 unreadable, 85 min
3. ASD build — complete, relocated to `docs/data-asd` (sibling, not child, of
   `docs/data` — see above), pushed as `8268e005d0a`
4. ASD UI — complete: one search box, five verdicts, both lookups run every
   time. Tested locally against real data (3 of 4 scenarios via the actual
   SHA-256+bucket lookup path against a local server; the 4th, found-on-both,
   via direct logic verification since no genuine overlap exists in sampled
   data) before pushing, then re-verified against the *live* site after
   deploy with the same real EPICs. Pushed as `1a991e24553`.
5. README and dashboard updated to describe the ASD feature and current
   (100%/100%) status — pushed as `090ada236fb`.
6. Full statewide overlap/duplicate audit (`13-overlap-audit.mjs`) —
   complete. **3,191 real collisions found** — see the dedicated section
   above. This is the one item on this list that actually changed a prior
   conclusion (the "the two lists are disjoint" sampled finding) rather than
   just confirming it, so read that section before assuming zero overlap
   anywhere else in this codebase's history of claims.
7. Test log book (`test-logs/`) — built and wired into all five
   verify/sweep scripts, committed, periodic committer running. See the
   dedicated section above.
8. Exhaustive per-booth sweep script (`14-exhaustive-sweep.mjs`) — built,
   smoke-tested, a real concurrency bug found and fixed mid-run. **ASD
   dataset PAUSED at 1,661/60,923 booths, by explicit user request** — see
   the dedicated section above for the exact resume command. Not abandoned,
   not forgotten — paused on purpose to free the machine for item 10.
9. Detailed PDF report on the overlap audit —
   `reports/overlap-audit-2026-08-30.pdf`, now 81 pages, full methodology,
   breakdown, sensitive-case discussion, and an appendix listing all 3,191
   collision EPICs. Generated programmatically (PyMuPDF's `Story` API) from
   `test-logs/test-log.jsonl`, no hand-typed figures. **Revised once already**
   after the EPIC-attribution bug below was found and fixed — the current
   version carries an explicit revision note at the top; do not treat an
   older cached copy (short, or missing the note) as current. Verified the
   raw `raw.githubusercontent.com` blob directly after each push.
10. **EPIC-attribution bug in the overlap audit — found by user manual
    verification, fixed, re-verified.** 10 of the 3,191 collisions had a
    wrong EPIC attached due to a suffix-only (not prefix+suffix) matching
    bug in the recovery step. See the dedicated section above for the full
    root cause, the fix, and the manual re-verification against `cache/rows`
    directly (not just re-trusting the script). This is now **done**, not
    queued — listed here for the ordering, since it happened between items
    9 and what follows.

Queued, in order:
11. **TOP PRIORITY, as of this write-up: OCR misreads that pass every
    existing check** — see the dedicated section above
    ("A second, independent, more serious finding"). Root cause understood
    (contact-sheet batching degrades Tesseract's read below what the same
    crop gets in isolation, at least for some cards) but **scope not yet
    measured** — unknown how many of ~44M published `ok:true` rows are
    affected. **Explicit user instruction: let the overlap-audit re-run
    finish (done, see item 10), then take this on priority — ahead of the
    CEO-gap investigation (item 12) that was already in progress when this
    was found.**
12. CEO-gap root cause investigation — **paused mid-investigation** to let
    the OCR-misread finding (item 11) take priority, per explicit
    instruction. Already found one real, related lead before pausing: the
    opt-in `ROLL_OCR_RETRY` second-pass recovers ~75% of grammar-*failing*
    EPICs in a small sample (see the dedicated section above) — but does
    **not** address item 11's failure mode (grammar-*passing* but wrong),
    so the two need to be resolved together, not treated as the same fix.
    If a fixable cause is found for either: patch it and re-pull **only the
    specific affected booths** — no full rebuild, nothing existing touched
    (explicit user constraint, unchanged since first queued).
13. **Roll dataset's exhaustive per-booth sweep — still deferred.**
    `node scripts/14-exhaustive-sweep.mjs --dataset roll --concurrency 8`
    (or similar) is ready to run; realistic cost is ~4 days continuous,
    CDN-bound. **Do not start it without being asked.**
14. ~~Resume the ASD exhaustive sweep~~ — **done, 2026-09-04.** Resumed
    per explicit user instruction (ahead of items 11-12 being fully
    settled — user's call, not this project's usual ordering), ran to
    completion: 60,923/60,923 booths, 0 real failures statewide. Found and
    fixed a real script bug along the way (bucket-fetch cache poisoning,
    `ba80c42cb04`). See the dedicated section above for full detail.
15. Publish/republish loop for ASD data going forward — no auto-publish
    script written yet. Low priority: ASD extraction is a one-shot, already-
    finished pass; revisit only if ECI revises ASD reports in place (untested
    — see `OBSERVATIONS-ASD.md` §8).
16. Now that a real overlap exists (item 6), consider whether the 3,191
    known collision EPICs deserve their own spot-check pass through the
    live site's actual verdict-3 UI path once picked up cold — not done
    this session, just noting the data now exists to make that check
    meaningful rather than theoretical.

### 8-AC deep confirmation pass applied; 50k-sample live-check false alarm closed — 2026-09-04

Picked up two loose ends left by the previous session (item 11's ongoing
work), both now resolved:

1. **The 50k-sample live-verification's one open "wrong location" flag was
   a false alarm in the checker, not a live-deploy bug.** Re-ran
   `verify-confirmed-rows-live.mjs` (written last session, never re-run
   after its first failing result) and got the same single flag as before:
   AC174/part424 — corrected serial713's new EPIC (`HGB3064268`) resolves
   on the live site to serial712, not 713. Root cause: serial712's own
   *un*corrected, genuinely-printed EPIC is verbatim `HGB3064268` — a
   pre-existing duplicate the correction collided into. The commit that
   applied the 288 corrections (`58d75e5789c`) already documented this
   exact case as "correctly resolved via the existing first-processed-wins
   policy" — i.e., already known-benign, just not reflected in the
   checker's classification logic, which only recognized the "hit not
   found at all" shape of a benign duplicate, not "hit found but under the
   other duplicate's serial." Fixed the classification (same-part,
   different-serial hits now also count as benign) and re-ran: **CLEAN,
   287 found + 1 known-benign duplicate, 0 real issues, 300/300 untouched
   buckets spot-checked clean.** Pushed as `77c758b2ba2`.
2. **8-AC deep confirmation pass — reviewed, applied, verified.** Last
   session added `--only-acs` to `measure_batching_error.py` and ran a
   deeper per-AC sample (25 cards/part across every part) on 8 ACs already
   flagged by broader sampling: 6, 20, 115, 145, 191, 207, 215, 219. That
   run finished unattended (`cache/ocr-batching-check-deep8-summary.json`,
   211 silent-mismatch candidates) with nobody having reviewed the crops
   yet. Built composite review sheets
   (`build_candidate_review_sheets.py`, 36 sheets) and manually pixel-
   reviewed **all 211** against their crops directly (not sampled — every
   one, per this bug's own standing rule that a clean-looking statistical
   pattern still needs individual verification; see AC190 GYV/GLV above
   for why that rule exists).

   **Result: every one of the 8 ACs turned out to be a single clean,
   consistent dominant prefix** — AC6→`ZTO`, AC20→`IYP`, AC115→`IOP`,
   AC145→`IUO`, AC191→`AOV`, AC207→`UII`, AC215→`IQG`, AC219→`AOH` — with
   **one unrelated outlier** (AC215/part46/serial481: prefix `GGB`, a
   pure digit-order scramble between batched/isolated readings, unrelated
   to the letter-confusion cluster; the published value was already
   correct there, no fix needed). Cross-checked every derived correction
   against whichever of batched/isolated actually shared the crop's digit
   suffix (7 candidates had batched/isolated digit suffixes that
   disagreed with each other — each of those 7 re-checked individually
   against its own crop rather than assumed).

   Of 211 candidates: **130 genuine misreads** (confirmed corrections)
   and **81 false positives** (batched/published was already correct;
   isolated was the false lead — consistent with this bug's known
   false-positive rate on the isolation side). Applied via
   `fix-confirmed-rows.mjs`, dry-run verified first (0 skipped, 0
   duplicate collisions), 260 bucket files touched across 8 ACs. All 211
   individual manual-review verdicts logged to `test-logs/test-log.jsonl`
   under layer `ocr-batching-check-manual-review-deep8` (via a small new
   `scripts/log-deep8-review.mjs`, same shape as the 10k pass's
   `-manual-review-10k` entries). Pushed as `6d383361d3f`.

   **These 8 ACs are now done** — no longer part of item 11's unmeasured
   scope. The two harder categories item 11 already identified (messy
   multi-prefix clusters needing per-pair verification like this one just
   got; genuine digit-to-digit misreads with no consensus-based fix) still
   apply to the rest of the state — this pass narrowed the list, it didn't
   close item 11 out entirely. Live-site verification of these 130
   corrections still needs to be run once the Pages deploy for
   `6d383361d3f` finishes (in progress as of this write-up) —
   `node scripts/verify-confirmed-rows-live.mjs cache/confirmed-corrections-deep8.json`
   (note: `cache/` is gitignored, so that exact file only exists on the
   machine that ran this session — regenerate from
   `cache/silent-candidates-deep8-reviewed.json`'s `CONFIRMED` entries if
   it's gone, same shape as the 50k pass's corrections file).

   **Update, same session: ran once the deploy finished — CLEAN.** All 130
   corrections live and correct (130/130 old EPICs gone, 130/130 new EPICs
   found at the right ac/part/serial, 0 duplicate-collision anomalies this
   time), 300/300 untouched buckets spot-checked clean. This item is now
   fully closed, not just applied.

   Also worth recording since it came up mid-session: **checked whether
   ECI has published Revision 2 of the SIR Draft Roll yet — no.** Probed
   the CDN directly (`.../SIR-DraftRoll-Revision2-KAN-1-WI.pdf` in place
   of the `Revision1` this project's URLs use) across 5 ACs spread across
   the state (1, 50, 100, 150, 161, 224) — all 404, `Revision1` still 200
   for the same parts. The dataset this project scrapes is still current
   against what's actually published; no action needed, just worth
   re-checking periodically since a real Revision 2 would obsolete
   everything scraped so far.

### ASD exhaustive sweep resumed; a real script bug found and fixed — 2026-09-04

Resumed `14-exhaustive-sweep.mjs --dataset asd` (item 14) from its
1,661/60,923 pause point, per explicit user instruction. Found and fixed a
real correctness bug in the script itself while it ran: `fetchBucket()`
cached a transient network failure as a permanent `null` for that hash
prefix (`.catch(() => null)`, then `bucketCache.set`), so one CDN blip
meant every later EPIC hashing to the same bucket silently read as
"missing from the live site" for the rest of the run — a false site-layer
fail indistinguishable from a real one. Caught by 6 fails landing in the
same ~3-second window across unrelated ACs (6, 8, 11, 39, 127, 176); all 6
individually re-verified live and correct. Fixed to match
`verifyBoothAgainstPdf`'s existing retry pattern — 3 attempts with
backoff, only caching on success — committed as `ba80c42cb04`. Sweep
restarted clean (done-ledger meant zero lost progress) and ran the rest of
the way with 0 further script-caused false alarms.

One more fail surfaced (`RSG4075990`, ac179/part110/serial66) that turned
out to be a **genuine duplicate EPIC in the raw published ASD data**, not
a bug: the same EPIC, name, and relative-name are printed twice by ECI —
once at ac179/part110/serial66, once at ac168/part161/serial307 — and the
live site's existing first-processed-wins policy (already documented in
the 50k live-check section above) keeps only the ac168 copy. Confirmed
directly against `cache/asd-rows/168.jsonl` and `179.jsonl`. Not fixed,
because there is nothing to fix — this is the same known-benign
duplicate-handling shape, just a new instance of it, this time spanning
two different ACs rather than two parts within one.

**Completed the same session: 60,923/60,923 ASD booths swept, 0 real
site-layer or PDF-layer failures statewide.** The only 8 fails logged
across the entire run were the 7 pre-fix false alarms above and the one
confirmed-benign cross-AC duplicate — every single one individually
accounted for, none left unexplained. This closes item 14.

### Roll dataset spot-check — 200-booth random sample, clean

Prompted by the same "check for data updates" request, and since the roll
dataset's own full extraction is separately confirmed complete (all
224 ACs, 60,923/60,923 parts in `cache/done/`, matching the CEO's own
polling-station count), ran a bounded random sample rather than the full
~4-day statewide sweep (item 13, still deliberately not started without
being asked): `node scripts/14-exhaustive-sweep.mjs --dataset roll --limit
200 --concurrency 8`. Also directly re-fetched AC196/part227, the exact
file the original CDN discovery hashed — **still byte-identical**, same
SHA-256 (`01e9555e…c402699e`), same 10,198,409 bytes, weeks later.

**Result: 200/200 booths, 0 site-layer fails, 1 PDF-layer fail — and that
one fail is a false alarm, pixel-verified.** AC161/part89/serial16 came
back "EPIC not found on re-read" because a *fresh* full-part OCR pass
misread the card as `WZZ3105590`; cropped and visually inspected the
actual card image directly (not just re-OCR'd again) and it unambiguously
reads `WZU3105590` — matching the already-published value exactly. This
is the same OCR-batching noise item 11 already documents at length (a
second automated pass disagreeing with a correctly-published first pass),
now caught going the *opposite* direction from every prior instance: here
the fresh re-read was the wrong one, not the cached data. No fix needed;
no real defect found in the 200-booth sample.

**Bottom line on "is there a data update": no, on either dataset.** No
Revision 2, no silent Revision-1 content change (byte-identical hash), no
ASD drift (0/60,923 real fails, full statewide sweep), no roll drift found
in a 200-booth statewide sample plus the one specific file the whole
project's CDN-legitimacy finding rests on.

### CEO press note, 04.09.2026 — not a Revision 2, but confirms project numbers and a hard deadline

The CEO's office posted a routine SIR-2026 status press note (via
`x.com/ceo_karnataka`, PDF at
`ceo.karnataka.gov.in/uploads/PRESS NOTE 04-09-2026.pdf`). Read in full
(21 pages). **Not a new roll publication** — it's notice-generation/
delivery progress, Form 6/6A/7/8 guidance, nothing that changes what this
project scrapes. Worth recording three things from it that are not
derivable from this repo:

1. **Independent confirmation of this project's part count.** Annexure-2
   states **60,923 polling stations statewide**, matching exactly what
   `1-discover.mjs`'s CDN probing already found and what the ASD
   exhaustive sweep (above) just finished checking against.
2. **Official explanation for the ABSENT/SHIFTED/DUPLICATE reason codes**
   already in the ASD dataset: item 8 of the note states plainly that "due
   to rationalisation of polling stations and re-serialisation of
   electors, the Part Number and Serial Number may have changed" — i.e.
   this is by design on ECI's side, not a data-quality problem, matching
   this project's own findings.
3. **A hard deadline that will eventually obsolete the current dataset**:
   the claims/objections window closes 23.09.2026, and the **Final
   Electoral Roll will be published 27.10.2026**. Everything this project
   has scraped is the *Draft* Roll; once the Final Roll ships, revisit
   whether it needs to be scraped as a distinct, newer dataset. Total
   statewide electors as of 04.09.2026: 4,46,38,124 (district breakdown in
   the note's Annexure-1), for whatever future cross-check that's worth.
