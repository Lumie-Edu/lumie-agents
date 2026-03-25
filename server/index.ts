import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import { DEFAULT_PORT } from './constants.js';
import { createServerState, setupWebSocket } from './wsServer.js';

const port = parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
const state = createServerState();

// Resolve asset/webview paths
const serverDir = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(serverDir, '..');
const webviewDist = path.join(projectRoot, 'dist', 'webview');

// Check if webview-ui is built
if (!fs.existsSync(webviewDist)) {
  console.error(
    `[Server] webview-ui/dist not found. Run 'cd webview-ui && npm run build' first.`,
  );
  process.exit(1);
}

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

function serveStaticFile(filePath: string, res: http.ServerResponse): void {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  let pathname = decodeURIComponent(url.pathname);

  // Serve index.html for root
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  const filePath = path.join(webviewDist, pathname);

  // Security: prevent directory traversal
  if (!filePath.startsWith(webviewDist)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // Try the exact file first, then fall back to index.html (SPA routing)
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serveStaticFile(filePath, res);
  } else {
    serveStaticFile(path.join(webviewDist, 'index.html'), res);
  }
});

// Setup WebSocket on the same HTTP server
setupWebSocket(server, state);

server.listen(port, '0.0.0.0', () => {
  console.log(`[Server] Pixel Agents running at http://0.0.0.0:${port}`);
  console.log(`[Server] Watching ~/.claude/projects/ for agent activity`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  state.layoutWatcher?.dispose();
  if (state.scanTimer) clearInterval(state.scanTimer);
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  state.layoutWatcher?.dispose();
  if (state.scanTimer) clearInterval(state.scanTimer);
  server.close();
  process.exit(0);
});
