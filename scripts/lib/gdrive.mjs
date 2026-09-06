/* Minimal Google Drive folder listing, for the CEO's "notices issued" data.
 *
 * That dataset does not live on ECI's own CDN like the roll and ASD PDFs do
 * (see HANDOFF.md section 2) — it is published as 34 independently-managed,
 * publicly-shared Drive folders, one per district, each hand-uploaded by
 * that district's own office. There is no API key requirement to read a
 * folder shared "anyone with the link": Drive's lightweight
 * `embeddedfolderview` endpoint (built for embedding a folder listing in an
 * iframe) returns a plain, unauthenticated HTML page listing that folder's
 * immediate children, both files and sub-folders. This is unofficial and
 * undocumented — it could change or start throttling without notice — but it
 * needs nothing from the person running this pipeline, unlike the Drive API
 * proper (which would need a Google Cloud project and an API key). Prefer
 * this until it demonstrably breaks.
 *
 * Folder depth is NOT consistent across districts — each office chose its
 * own structure (see HANDOFF.md's notices-feature section). Callers must
 * walk the tree themselves rather than assume a fixed depth. */

import { get, sleep } from './common.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// The 400-char window used to sit between href and title before this, but a
// file entry's thumbnail (a long googleusercontent.com URL) pushes that
// distance past 500 chars — measured directly on a real "notices" leaf
// folder, not assumed. 900 covers it with headroom.
const ENTRY_RE =
  /href="https:\/\/drive\.google\.com\/(drive\/folders|file\/d)\/([A-Za-z0-9_-]+)[^"]*"[^>]*>[\s\S]{0,900}?flip-entry-title">([^<]+)</g;

/** One folder's immediate children. `kind` is 'folder' or 'file'. */
export async function listFolder(folderId, { tries = 4 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const html = (
        await get(`https://drive.google.com/embeddedfolderview?id=${folderId}#list`, {
          headers: { 'user-agent': UA }
        })
      ).toString('utf8');
      const entries = [];
      for (const m of html.matchAll(ENTRY_RE)) {
        entries.push({
          id: m[2],
          kind: m[1] === 'drive/folders' ? 'folder' : 'file',
          name: m[3].trim()
        });
      }
      return entries;
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await sleep(1000 * attempt * attempt);
    }
  }
  throw new Error(`listFolder(${folderId}) failed after ${tries} tries: ${lastErr?.message}`);
}

/** Direct download for a Drive file ID. Only safe for files small enough to
 * skip Drive's "can't scan for viruses" interstitial (everything seen in this
 * dataset so far is a few hundred KB, well under that threshold). */
export async function downloadFile(fileId, { tries = 4 } = {}) {
  return get(`https://drive.google.com/uc?export=download&id=${fileId}`, {
    headers: { 'user-agent': UA },
    tries
  });
}
