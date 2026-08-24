/* Local preview of docs/ — GitHub Pages serves the same directory verbatim.
   `npm run serve` then open http://localhost:8080 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { DOCS } from './lib/common.mjs';

const port = Number(process.argv[2] ?? 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
  const path = join(DOCS, rel);
  if (!resolve(path).startsWith(resolve(DOCS))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store'
    });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('404');
  }
}).listen(port, () => process.stdout.write(`docs/ on http://localhost:${port}\n`));
