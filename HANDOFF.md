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
