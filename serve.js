#!/usr/bin/env node
/* Serves the board on http://localhost:8765 and opens a browser at it.
 *
 * The board is a private, local tool: this listens on the loopback address
 * only, so nothing outside this computer can reach it. No dependencies —
 * plain Node, nothing to install.
 *
 *   node serve.js            # port 8765
 *   node serve.js 9000       # a different port
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8765;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';

  const file = path.join(ROOT, rel);
  // Refuse anything that resolves outside the board's own folder.
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + rel);
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  The board may already be running — try http://localhost:${PORT}/`);
    console.error(`  Or start it on another port:  node serve.js ${PORT + 1}\n`);
    process.exit(1);
  }
  throw err;
});

// 127.0.0.1 rather than 0.0.0.0: reachable from this machine only.
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`\n  AEM Baltic task board running at ${url}`);
  console.log('  This computer only — nothing is exposed to the network.');
  console.log('  Press Ctrl+C to stop.\n');
  openBrowser(url);
});

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
            : process.platform === 'darwin' ? ['open', [url]]
            : ['xdg-open', [url]];
  const miss = () => console.log(`  (Could not open a browser automatically — go to ${url})`);
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    // A missing opener reports itself through an async 'error' event, not a
    // throw. Without this handler it would take the whole server down with it.
    child.on('error', miss);
    child.unref();
  } catch {
    miss();
  }
}
