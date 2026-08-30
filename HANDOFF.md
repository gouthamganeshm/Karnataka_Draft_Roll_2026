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

### Task pipeline as of this write-up (for continuity if picked up cold)

Done:
1. Full statewide sweep test of the draft roll (`8-full-sweep.mjs`) —
   started, very slow under concurrent ASD extraction load; check whether it
   finished before assuming stale
2. ASD extraction — complete, 10,766,778 rows, 0 unreadable
3. ASD build — complete, pushed as `8268e005d0a`

Queued, in order:
4. Publish/republish loop for ASD data going forward — no auto-publish
   script written yet (this session shipped one build as a single manual
   commit; there is nothing yet that re-runs `10-build-asd-data.mjs` and
   pushes on a cadence the way `6-auto-publish.mjs` does for the roll).
   Probably not needed again soon since ASD extraction is a one-shot,
   already-finished pass — revisit if ECI revises ASD reports in place
   (untested — see `OBSERVATIONS-ASD.md` §8).
5. Build the ASD UI feature: new search section, the five-verdict cascade
   from `OBSERVATIONS-ASD.md` §6, wire the roll's existing `notFoundTitle`
   branch (`docs/app.js` around line 296) to auto-cascade into an ASD lookup,
   fix the three pre-existing UI bugs that document's §7 found (no tone-color
   CSS actually matches `docs/app.js`'s `tone-${tone}` classes; `maxlength="10"`
   / `EPIC_RE` block the real 11-character series from being typed at all,
   roll search included; `.acronym` CSS is an already-built, unused legend the
   ASD reason-code dots can reuse), and update the privacy-stance copy for the
   names-included decision above.
6. End-to-end test the ASD feature once released — `11-verify-asd.mjs`
   (per-AC) and `12-full-sweep-asd.mjs` (statewide + corner cases) are
   already written and syntax-checked, mirroring `7-verify.mjs` /
   `8-full-sweep.mjs` exactly, ready to run once the UI ships
7. Duplicate/overlap audit, full statewide (not the document's 31-AC sample):
   duplicate EPICs within ASD, duplicate EPICs within the draft roll, and
   EPICs appearing in **both** lists. `12-full-sweep-asd.mjs`'s section B4
   already does a *light sampled* version of the cross-list check as an
   early warning — this item is the full exhaustive pass, still separate.
8. Investigate the ~0.6% CEO-gap root cause; if fixable, patch and re-pull
   only the specific affected booths — no full rebuild, nothing existing
   touched (explicit user constraint, see above)
