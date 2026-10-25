// Serves the demo app with a tiny in-memory API, so a scene file has something to seed.
//   node server.mjs [--port 4310]
// GET /api/worklist returns the dashboard's worklist; POST /api/seed replaces it (see seed.mjs).
// /events and /stream stay open forever (the /live page uses them). Every other path that is not a
// file falls back to index.html (client-side routes).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function serveDemoApp({ port = 4310, host = '127.0.0.1' } = {}) {
  let worklist = [];
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (urlPath === '/api/worklist' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(worklist));
      return;
    }
    if (urlPath === '/api/seed' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        try {
          const items = JSON.parse(body).worklist;
          if (!Array.isArray(items)) throw new Error('worklist must be an array');
          worklist = items.map((i) => ({ title: String(i.title), due: String(i.due) }));
          res.writeHead(204).end();
        } catch (e) {
          res.writeHead(400, { 'content-type': 'text/plain' }).end(String(e.message));
        }
      });
      return;
    }
    if (urlPath === '/events' || urlPath === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: 2 new updates\n\n');
      return;
    }
    let file = path.join(APP_DIR, path.normalize(urlPath));
    if (!file.startsWith(APP_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(APP_DIR, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 4310;
  const server = await serveDemoApp({ port });
  console.log(`Demo Co is running at http://127.0.0.1:${server.address().port}/`);
}
