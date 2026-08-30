/* Where the bucket files live.
 *
 * The site is a few hundred KB and sits on Pages; the data is ~4 GB and sits in
 * a public Cloudflare R2 bucket, because GitHub Pages caps a published site at
 * 1 GB. Point DATA_BASE at the bucket's public URL (or at a custom domain in
 * front of it). A trailing slash is optional.
 *
 * './data' works for a local preview: `npm run serve` after `npm run build`. */
window.ROLL_CONFIG = {
  DATA_BASE: './data',
  // The ASD ("uncollectable elector") dataset — a sibling tree, not a child
  // of DATA_BASE, matching docs/data-asd's placement on disk (see
  // scripts/10-build-asd-data.mjs for why that separation is load-bearing).
  ASD_DATA_BASE: './data-asd'
};
