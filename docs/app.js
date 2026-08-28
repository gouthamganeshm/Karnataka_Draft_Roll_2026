/* Karnataka draft roll 2026 — client-side lookup.
 *
 * Everything here runs in the browser against static files. The EPIC the user
 * types is hashed locally and only ever used to pick a bucket file shared by
 * thousands of other numbers, so no request ever carries it. */

const BASE = (window.ROLL_CONFIG?.DATA_BASE ?? './data').replace(/\/+$/, '');
const EPIC_RE = /^[A-Z]{3}[0-9]{7}$/;

/* Every published part sits at a deterministic, public path on ECI's own CDN —
 * no captcha, no session (see HANDOFF.md section 2). A result can therefore
 * link straight to the exact page a claim or an appeal needs to cite, built
 * from the AC and part number the lookup already returned — nothing new has to
 * be stored to offer this. */
const partPdfUrl = (acNo, partNo) =>
  `https://voters.eci.gov.in/eroll/2026/s10/sir-draftroll/${acNo}/` +
  `2026-EROLLGEN-S10-${acNo}-SIR-DraftRoll-Revision1-KAN-${partNo}-WI.pdf`;

/* Below this, a "not on the roll" answer is not trustworthy: the number could
 * be missing because the import has not reached its booth yet. 99% rather than
 * 100% because a handful of booths are always unreadable at the source, and
 * holding the whole site hostage to them would help nobody. */
const NEGATIVE_VERDICT_COVERAGE = 99;

// ---------------------------------------------------------------- i18n

const STRINGS = {
  en: {
    skip: 'Skip to the EPIC search',
    title: 'Karnataka Draft Roll 2026',
    tagline: 'Check whether your voter ID is on the SIR draft electoral roll, and which booth it sits in',
    lookupHeading: 'Search the draft roll',
    intro: 'The draft roll for the Special Intensive Revision 2026 was published as one PDF per polling booth — around 58,000 of them. This searches all of them at once and tells you whether your number is on the roll, and which booth it sits in. If your entry is missing, that is what the claims and objections window is for.',
    scopeNote: 'The published rolls are page images, not text, so this site reads them by OCR and indexes only the two fields it can verify exactly: the EPIC number and the serial. Names, ages and relatives are not held here — check those on the official PDF.',
    privacyNote: 'The number you type never leaves this device. The search runs in your browser against pre-computed data files.',
    epicLabel: 'EPIC number',
    epicHelp: 'Printed on the front of your voter ID card. Exactly 3 letters followed by 7 digits.',
    checkBtn: 'Search this EPIC',
    dashHeading: 'What is in this dataset',
    districtTitle: 'Import coverage by district',
    districtSub: 'A constituency is only searchable once every one of its booths has been read. Click a column heading to sort.',
    footerSource: 'Source: the draft electoral roll published by the Chief Electoral Officer, Karnataka for the Special Intensive Revision 2026. This site is an independent, unofficial reformatting of those documents. Always confirm with your BLO or voters.eci.gov.in before acting.',
    footerLink: 'Official draft roll download on voters.eci.gov.in',
    footerCeo: 'Chief Electoral Officer, Karnataka',
    footerOfficialStats: 'Official count as of 28 August 2026: 4,46,35,948 electors statewide (Chief Electoral Officer, Karnataka).',
    footerOfficialStatsLink: 'Read the official press note (PDF) ↗',

    errFormat: 'That does not look like an EPIC number. It is 3 letters followed by 7 digits, like ABC1234567.',
    errNetwork: 'Could not load the data files. Check your connection and try again.',
    searching: 'Searching…',

    foundTitle: 'On the draft roll',
    foundLede: 'This EPIC number appears in the draft roll published on {date}.',
    notFoundTitle: 'Not on the draft roll',
    notFoundLede: 'This EPIC number does not appear anywhere in the draft roll. If you believe it should, file a claim before {deadline}.',
    unsureTitle: 'Cannot say yet',
    unsureLede: 'This EPIC was not found, but only {pct}% of the state has been imported so far. A missing result at this stage does not mean you have been left off the roll — check again once coverage is complete.',
    checkOfficial: 'Confirm on the official portal',
    checkAgain: 'Search another number',
    print: 'Print this result', fAc: 'Constituency', fPart: 'Booth', fSerial: 'Serial number',
    viewSourcePdf: 'View this booth’s official roll PDF ↗',

    tileElectors: 'Electors indexed', tileAcs: 'Constituencies', tileParts: 'Polling booths',
    tileCoverage: 'State coverage',
    coverageFull: 'All {parts} booths across {acs} constituencies have been read.',
    coveragePartial: 'Read {done} of {parts} booths ({pct}%). Constituencies still importing cannot be searched, and a “not on the roll” answer is withheld until coverage passes ' + NEGATIVE_VERDICT_COVERAGE + '%.',
    provenance: 'Draft roll published {published}. Data last rebuilt {built}.',
    colDistrict: 'District', colAcs: 'Constituencies', colParts: 'Booths',
    colDone: 'Read', colElectors: 'Electors', colPct: 'Coverage',
    notLive: 'The draft roll has not been published yet. It is due on 24 August 2026.',
    deadlineClaims: 'Claims and objections close on {date}. If your entry is missing or wrong, act before then.'
  },
  kn: {
    skip: 'ಇಪಿಐಸಿ ಹುಡುಕಾಟಕ್ಕೆ ಹೋಗಿ',
    title: 'ಕರ್ನಾಟಕ ಕರಡು ಮತದಾರರ ಪಟ್ಟಿ ೨೦೨೬',
    tagline: 'ಎಸ್‌ಐಆರ್ ಕರಡು ಮತದಾರರ ಪಟ್ಟಿಯಲ್ಲಿ ನಿಮ್ಮ ಇಪಿಐಸಿ ಇದೆಯೇ ಮತ್ತು ಯಾವ ಮತಗಟ್ಟೆಯಲ್ಲಿದೆ ಎಂದು ಪರಿಶೀಲಿಸಿ',
    lookupHeading: 'ಕರಡು ಪಟ್ಟಿಯಲ್ಲಿ ಹುಡುಕಿ',
    intro: 'ವಿಶೇಷ ತೀವ್ರ ಪರಿಷ್ಕರಣೆ ೨೦೨೬ರ ಕರಡು ಪಟ್ಟಿಯನ್ನು ಪ್ರತಿ ಮತಗಟ್ಟೆಗೆ ಒಂದರಂತೆ ಸುಮಾರು ೫೮,೦೦೦ ಪಿಡಿಎಫ್‌ಗಳಾಗಿ ಪ್ರಕಟಿಸಲಾಗಿದೆ. ಇಲ್ಲಿ ಎಲ್ಲವನ್ನೂ ಒಟ್ಟಿಗೆ ಹುಡುಕಿ ನಿಮ್ಮ ಸಂಖ್ಯೆ ಪಟ್ಟಿಯಲ್ಲಿದೆಯೇ ಮತ್ತು ಯಾವ ಮತಗಟ್ಟೆಯಲ್ಲಿದೆ ಎಂದು ತಿಳಿಯಬಹುದು.',
    scopeNote: 'ಪ್ರಕಟಿತ ಪಟ್ಟಿಗಳು ಪಠ್ಯವಲ್ಲ, ಪುಟದ ಚಿತ್ರಗಳು. ಆದ್ದರಿಂದ ಈ ತಾಣ ಅವುಗಳನ್ನು ಒಸಿಆರ್ ಮೂಲಕ ಓದಿ, ನಿಖರವಾಗಿ ಪರಿಶೀಲಿಸಬಹುದಾದ ಎರಡು ಕ್ಷೇತ್ರಗಳನ್ನು ಮಾತ್ರ ಸೂಚಿಸುತ್ತದೆ: ಇಪಿಐಸಿ ಸಂಖ್ಯೆ ಮತ್ತು ಕ್ರಮ ಸಂಖ್ಯೆ. ಹೆಸರು, ವಯಸ್ಸು, ಸಂಬಂಧಿಗಳ ವಿವರ ಇಲ್ಲಿಲ್ಲ — ಅವುಗಳನ್ನು ಅಧಿಕೃತ ಪಿಡಿಎಫ್‌ನಲ್ಲಿ ಪರಿಶೀಲಿಸಿ.',
    privacyNote: 'ನೀವು ಟೈಪ್ ಮಾಡುವ ಸಂಖ್ಯೆ ಈ ಸಾಧನವನ್ನು ಬಿಟ್ಟು ಹೋಗುವುದಿಲ್ಲ. ಹುಡುಕಾಟ ನಿಮ್ಮ ಬ್ರೌಸರ್‌ನಲ್ಲಿಯೇ ನಡೆಯುತ್ತದೆ.',
    epicLabel: 'ಇಪಿಐಸಿ ಸಂಖ್ಯೆ',
    epicHelp: 'ನಿಮ್ಮ ಮತದಾರ ಗುರುತಿನ ಚೀಟಿಯ ಮುಂಭಾಗದಲ್ಲಿದೆ. ೩ ಅಕ್ಷರ ನಂತರ ೭ ಅಂಕಿಗಳು.',
    checkBtn: 'ಈ ಇಪಿಐಸಿ ಹುಡುಕಿ',
    dashHeading: 'ಈ ದತ್ತಾಂಶದಲ್ಲಿ ಏನಿದೆ',
    districtTitle: 'ಜಿಲ್ಲಾವಾರು ಆಮದು ವ್ಯಾಪ್ತಿ',
    districtSub: 'ಎಲ್ಲಾ ಮತಗಟ್ಟೆಗಳನ್ನು ಓದಿದ ನಂತರವೇ ಕ್ಷೇತ್ರವನ್ನು ಹುಡುಕಬಹುದು.',
    footerSource: 'ಮೂಲ: ಮುಖ್ಯ ಚುನಾವಣಾಧಿಕಾರಿ, ಕರ್ನಾಟಕ ಪ್ರಕಟಿಸಿದ ಎಸ್‌ಐಆರ್ ೨೦೨೬ ಕರಡು ಮತದಾರರ ಪಟ್ಟಿ. ಇದು ಅನಧಿಕೃತ ಮರುರಚನೆ. ಕ್ರಮ ಕೈಗೊಳ್ಳುವ ಮೊದಲು ನಿಮ್ಮ ಬಿಎಲ್‌ಒ ಅಥವಾ voters.eci.gov.in ನಲ್ಲಿ ಖಚಿತಪಡಿಸಿಕೊಳ್ಳಿ.',
    footerLink: 'voters.eci.gov.in ನಲ್ಲಿ ಅಧಿಕೃತ ಕರಡು ಪಟ್ಟಿ',
    footerCeo: 'ಮುಖ್ಯ ಚುನಾವಣಾಧಿಕಾರಿ, ಕರ್ನಾಟಕ',
    footerOfficialStats: '೨೮ ಆಗಸ್ಟ್ ೨೦೨೬ರಂತೆ ಅಧಿಕೃತ ಎಣಿಕೆ: ರಾಜ್ಯಾದ್ಯಂತ ೪,೪೬,೩೫,೯೪೮ ಮತದಾರರು (ಮುಖ್ಯ ಚುನಾವಣಾಧಿಕಾರಿ, ಕರ್ನಾಟಕ).',
    footerOfficialStatsLink: 'ಅಧಿಕೃತ ಪತ್ರಿಕಾ ಟಿಪ್ಪಣಿಯನ್ನು ಓದಿ (ಪಿಡಿಎಫ್) ↗',

    errFormat: 'ಇದು ಇಪಿಐಸಿ ಸಂಖ್ಯೆಯಂತೆ ಕಾಣುತ್ತಿಲ್ಲ. ೩ ಅಕ್ಷರ ನಂತರ ೭ ಅಂಕಿಗಳು, ಉದಾ. ABC1234567.',
    errNetwork: 'ದತ್ತಾಂಶ ಕಡತಗಳನ್ನು ಲೋಡ್ ಮಾಡಲಾಗಲಿಲ್ಲ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',
    searching: 'ಹುಡುಕಲಾಗುತ್ತಿದೆ…',

    foundTitle: 'ಕರಡು ಪಟ್ಟಿಯಲ್ಲಿದೆ',
    foundLede: '{date} ರಂದು ಪ್ರಕಟವಾದ ಕರಡು ಪಟ್ಟಿಯಲ್ಲಿ ಈ ಇಪಿಐಸಿ ಸಂಖ್ಯೆ ಇದೆ.',
    notFoundTitle: 'ಕರಡು ಪಟ್ಟಿಯಲ್ಲಿ ಇಲ್ಲ',
    notFoundLede: 'ಈ ಇಪಿಐಸಿ ಸಂಖ್ಯೆ ಕರಡು ಪಟ್ಟಿಯಲ್ಲಿ ಎಲ್ಲಿಯೂ ಕಂಡುಬಂದಿಲ್ಲ. ಇರಬೇಕಿತ್ತು ಎಂದು ನೀವು ಭಾವಿಸಿದರೆ {deadline} ರೊಳಗೆ ಕ್ಲೇಮ್ ಸಲ್ಲಿಸಿ.',
    unsureTitle: 'ಇನ್ನೂ ಹೇಳಲಾಗದು',
    unsureLede: 'ಈ ಇಪಿಐಸಿ ಕಂಡುಬಂದಿಲ್ಲ, ಆದರೆ ರಾಜ್ಯದ {pct}% ಮಾತ್ರ ಆಮದಾಗಿದೆ. ಈ ಹಂತದಲ್ಲಿ ಕಂಡುಬರದಿರುವುದು ನಿಮ್ಮನ್ನು ಪಟ್ಟಿಯಿಂದ ಕೈಬಿಡಲಾಗಿದೆ ಎಂದರ್ಥವಲ್ಲ.',
    checkOfficial: 'ಅಧಿಕೃತ ಪೋರ್ಟಲ್‌ನಲ್ಲಿ ಖಚಿತಪಡಿಸಿ',
    checkAgain: 'ಮತ್ತೊಂದು ಸಂಖ್ಯೆ ಹುಡುಕಿ',
    print: 'ಈ ಫಲಿತಾಂಶ ಮುದ್ರಿಸಿ', fAc: 'ಕ್ಷೇತ್ರ', fPart: 'ಮತಗಟ್ಟೆ', fSerial: 'ಕ್ರಮ ಸಂಖ್ಯೆ',
    viewSourcePdf: 'ಈ ಮತಗಟ್ಟೆಯ ಅಧಿಕೃತ ಪಟ್ಟಿ ಪಿಡಿಎಫ್ ನೋಡಿ ↗',

    tileElectors: 'ಸೂಚಿಸಲಾದ ಮತದಾರರು', tileAcs: 'ಕ್ಷೇತ್ರಗಳು', tileParts: 'ಮತಗಟ್ಟೆಗಳು',
    tileCoverage: 'ರಾಜ್ಯ ವ್ಯಾಪ್ತಿ',
    coverageFull: '{acs} ಕ್ಷೇತ್ರಗಳ ಎಲ್ಲಾ {parts} ಮತಗಟ್ಟೆಗಳನ್ನು ಓದಲಾಗಿದೆ.',
    coveragePartial: '{parts} ರಲ್ಲಿ {done} ಮತಗಟ್ಟೆಗಳನ್ನು ಓದಲಾಗಿದೆ ({pct}%).',
    provenance: 'ಕರಡು ಪಟ್ಟಿ {published} ರಂದು ಪ್ರಕಟವಾಗಿದೆ. ದತ್ತಾಂಶ {built} ರಂದು ಮರುನಿರ್ಮಿಸಲಾಗಿದೆ.',
    colDistrict: 'ಜಿಲ್ಲೆ', colAcs: 'ಕ್ಷೇತ್ರಗಳು', colParts: 'ಮತಗಟ್ಟೆಗಳು',
    colDone: 'ಓದಲಾಗಿದೆ', colElectors: 'ಮತದಾರರು', colPct: 'ವ್ಯಾಪ್ತಿ',
    notLive: 'ಕರಡು ಪಟ್ಟಿ ಇನ್ನೂ ಪ್ರಕಟವಾಗಿಲ್ಲ. ೨೪ ಆಗಸ್ಟ್ ೨೦೨೬ ರಂದು ನಿರೀಕ್ಷಿಸಲಾಗಿದೆ.',
    deadlineClaims: 'ಕ್ಲೇಮ್ ಮತ್ತು ಆಕ್ಷೇಪಣೆಗಳು {date} ರಂದು ಮುಕ್ತಾಯಗೊಳ್ಳುತ್ತವೆ.'
  }
};

let lang = localStorage.getItem('roll-lang') === 'kn' ? 'kn' : 'en';
const t = (key, vars) => {
  let s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
};

// ---------------------------------------------------------------- helpers

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmtNum = (n) => (n ?? 0).toLocaleString(lang === 'kn' ? 'kn-IN' : 'en-IN');
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(+d) ? iso
    : d.toLocaleDateString(lang === 'kn' ? 'kn-IN' : 'en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
};

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const cache = new Map();
async function fetchJson(path) {
  if (cache.has(path)) return cache.get(path);
  const p = fetch(`${BASE}/${path}`, { referrerPolicy: 'no-referrer' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  cache.set(path, p);
  return p;
}

/* Bucket paths are two levels deep past the first two hex chars so no single
 * directory holds 65,536 files — some CDNs and most filesystems cope badly. */
const bucketPath = (prefix) =>
  prefix.length > 2 ? `roll/${prefix.slice(0, 2)}/${prefix.slice(2)}.json` : `roll/${prefix}.json`;

// ---------------------------------------------------------------- state

let manifest = null;

// ---------------------------------------------------------------- lookup

/** Records are sorted by their hash suffix, so this is a binary search. */
function findInBucket(records, suffix) {
  let lo = 0;
  let hi = records.length - 1;
  const hits = [];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = records[mid][0];
    if (v < suffix) lo = mid + 1;
    else if (v > suffix) hi = mid - 1;
    else {
      // A suffix collision is possible; collect every neighbour that matches.
      let i = mid;
      while (i >= 0 && records[i][0] === suffix) i--;
      for (let j = i + 1; j < records.length && records[j][0] === suffix; j++) hits.push(records[j]);
      break;
    }
  }
  return hits;
}

async function lookupEpic(epic) {
  const hash = await sha256hex(epic);
  const depth = manifest.shardDepth;
  const bucket = await fetchJson(bucketPath(hash.slice(0, depth)));
  if (!bucket) return [];
  return findInBucket(bucket, hash.slice(depth, depth + manifest.suffixLength));
}

// ---------------------------------------------------------------- rendering

const acLabel = (acNo) => {
  const ac = manifest.acs[acNo];
  if (!ac) return `AC ${acNo}`;
  return `${acNo} — ${lang === 'kn' && ac.nameKn ? ac.nameKn : ac.name}`;
};

function recordFields(rec, partName) {
  const [, acNo, partNo, serial] = rec;
  return [
    [t('fAc'), acLabel(acNo)],
    [t('fPart'), partName ? `${partNo} — ${partName}` : String(partNo)],
    [t('fSerial'), serial]
  ].filter(([, v]) => v !== '' && v != null);
}

function renderCard({ tone, title, lede, rec, partName, extra }) {
  const result = $('#result');
  result.hidden = false;
  result.replaceChildren();

  const card = el('div', `result-card tone-${tone}`);
  card.append(el('h2', null, title));
  if (lede) card.append(el('p', 'lede', lede));

  if (rec) {
    const dl = el('dl', 'record');
    for (const [k, v] of recordFields(rec, partName)) {
      dl.append(el('dt', null, k), el('dd', null, String(v)));
    }
    card.append(dl);

    const [, acNo, partNo] = rec;
    const src = el('a', 'source-link', t('viewSourcePdf'));
    src.href = partPdfUrl(acNo, partNo);
    src.target = '_blank';
    src.rel = 'noopener noreferrer';
    card.append(src);
  }
  if (extra) card.append(extra);

  const actions = el('div', 'result-actions');
  const official = el('a', 'ghost-btn', t('checkOfficial'));
  official.href = 'https://voters.eci.gov.in/download-eroll?stateCode=S10';
  official.target = '_blank';
  official.rel = 'noopener noreferrer';
  const again = el('button', 'ghost-btn', t('checkAgain'));
  again.type = 'button';
  again.addEventListener('click', () => {
    result.hidden = true;
    $('#epic').value = '';
    $('#epic').focus();
  });
  const print = el('button', 'ghost-btn', t('print'));
  print.type = 'button';
  print.addEventListener('click', () => window.print());
  actions.append(official, again, print);
  card.append(actions);

  result.append(card);
  result.focus();
}

const renderMessage = (tone, title, lede) => renderCard({ tone, title, lede });

// ---------------------------------------------------------------- handlers

async function handleEpic() {
  const epic = $('#epic').value.trim().toUpperCase();
  if (!EPIC_RE.test(epic)) return renderMessage('warn', t('errFormat'), '');

  renderMessage('info', t('searching'), '');
  let hits;
  try {
    hits = await lookupEpic(epic);
  } catch {
    return renderMessage('warn', t('errNetwork'), '');
  }

  if (hits.length) {
    const rec = hits[0];
    const parts = await fetchJson(`parts/${rec[1]}.json`);
    return renderCard({
      tone: 'found',
      title: t('foundTitle'),
      lede: t('foundLede', { date: fmtDate(manifest.publishedAt) }),
      rec,
      partName: parts?.[rec[2]] ?? ''
    });
  }

  // The honest-negative rule: only claim absence when the state is essentially
  // fully imported. Anything less and a missing record is our gap, not theirs.
  if (manifest.coverage >= NEGATIVE_VERDICT_COVERAGE) {
    return renderMessage('notfound', t('notFoundTitle'),
      t('notFoundLede', { deadline: fmtDate(manifest.claimsCloseAt) }));
  }
  return renderMessage('warn', t('unsureTitle'), t('unsureLede', { pct: manifest.coverage.toFixed(1) }));
}

// ---------------------------------------------------------------- dashboard

function renderDashboard() {
  const tiles = $('#tiles');
  tiles.replaceChildren();
  const stats = [
    [t('tileElectors'), fmtNum(manifest.electors)],
    [t('tileAcs'), fmtNum(manifest.constituencies)],
    [t('tileParts'), fmtNum(manifest.parts)],
    [t('tileCoverage'), `${manifest.coverage.toFixed(1)}%`]
  ];
  for (const [label, value] of stats) {
    const tile = el('div', 'tile');
    tile.append(el('div', 'tile-value', value), el('div', 'tile-label', label));
    tiles.append(tile);
  }

  $('#coverage-line').textContent = manifest.coverage >= 100
    ? t('coverageFull', { parts: fmtNum(manifest.parts), acs: fmtNum(manifest.constituencies) })
    : t('coveragePartial', {
        done: fmtNum(manifest.partsDone), parts: fmtNum(manifest.parts),
        pct: manifest.coverage.toFixed(1)
      });

  $('#data-provenance').textContent = t('provenance', {
    published: fmtDate(manifest.publishedAt), built: fmtDate(manifest.builtAt)
  });

  renderDistrictTable();
}

let sortKey = 'district';
let sortDir = 1;

function districtRows() {
  const by = new Map();
  for (const [no, a] of Object.entries(manifest.acs)) {
    if (!by.has(a.district)) by.set(a.district, { district: a.district, acs: 0, parts: 0, done: 0, electors: 0 });
    const row = by.get(a.district);
    row.acs++;
    row.parts += a.parts;
    row.done += a.partsDone;
    row.electors += a.electors;
    void no;
  }
  return [...by.values()].map((r) => ({ ...r, pct: r.parts ? (r.done / r.parts) * 100 : 0 }));
}

function renderDistrictTable() {
  const table = $('#district-table');
  const cols = [
    ['district', t('colDistrict')], ['acs', t('colAcs')], ['parts', t('colParts')],
    ['done', t('colDone')], ['electors', t('colElectors')], ['pct', t('colPct')]
  ];
  const thead = el('tr');
  for (const [key, label] of cols) {
    const th = el('th', key === sortKey ? 'is-sorted' : null, label);
    th.tabIndex = 0;
    th.setAttribute('role', 'button');
    const sort = () => {
      if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = key === 'district' ? 1 : -1; }
      renderDistrictTable();
    };
    th.addEventListener('click', sort);
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } });
    thead.append(th);
  }
  table.tHead.replaceChildren(thead);

  const rows = districtRows().sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * sortDir;
  });

  const body = table.tBodies[0];
  body.replaceChildren();
  for (const r of rows) {
    const tr = el('tr');
    tr.append(
      el('td', null, r.district),
      el('td', 'num', fmtNum(r.acs)),
      el('td', 'num', fmtNum(r.parts)),
      el('td', 'num', fmtNum(r.done)),
      el('td', 'num', fmtNum(r.electors)),
      el('td', 'num', `${r.pct.toFixed(1)}%`)
    );
    body.append(tr);
  }
}

// ---------------------------------------------------------------- chrome

function applyLang() {
  document.documentElement.lang = lang;
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const btn of document.querySelectorAll('.switch-btn')) {
    btn.classList.toggle('is-active', btn.dataset.lang === lang);
  }
  if (manifest) renderDashboard();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('roll-theme', theme);
  $('#theme-icon').textContent = theme === 'dark' ? '☀' : '☾';
}

function wire() {
  for (const btn of document.querySelectorAll('.switch-btn')) {
    btn.addEventListener('click', () => {
      lang = btn.dataset.lang;
      localStorage.setItem('roll-lang', lang);
      applyLang();
    });
  }
  $('#theme-btn').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  $('#lookup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    handleEpic();
  });
}

// ---------------------------------------------------------------- start

applyTheme(localStorage.getItem('roll-theme')
  ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
wire();

manifest = await fetchJson('manifest.json');

if (!manifest) {
  // No data yet — say so plainly rather than letting an empty dashboard imply
  // that the roll exists and nobody is on it.
  $('#deadline-banner').hidden = false;
  $('#deadline-banner-text').textContent = t('notLive');
  $('#lookup-form').querySelector('#submit-btn').disabled = true;
  applyLang();
} else {
  applyLang();
  if (manifest.claimsCloseAt) {
    $('#deadline-banner').hidden = false;
    $('#deadline-banner-text').textContent = t('deadlineClaims', { date: fmtDate(manifest.claimsCloseAt) });
  }
  $('#footer-meta').textContent =
    `${fmtNum(manifest.electors)} · ${fmtNum(manifest.parts)} · ${fmtDate(manifest.builtAt)}`;
}
