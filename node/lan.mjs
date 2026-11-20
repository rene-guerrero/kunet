/**
 * The PC dev host: one HTTP server on the local network that serves a game's web build and the same
 * room routes as the Worker, backed by a LocalHost in this Node process.
 *
 *   GET  /                          → the game (index.html gets window.__KUNET_LOCAL__ injected)
 *   POST /api/rooms?pid=            → { code }
 *   GET  /api/rooms/:code           → RoomInfo
 *   GET  /api/rooms/:code/ws?pid=   → WebSocket into the room
 *
 * Page and socket share one plain-http origin, so browsers on the LAN (PC, phone) join without
 * mixed-content trouble and without internet.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** the IPv4 addresses other devices can reach (Wi-Fi, Ethernet, hotspot), private ranges first */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue; // link-local: no DHCP
      out.push({ name, address: a.address });
    }
  }
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a.address) - rank(b.address));
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/**
 * @param {{
 *   root: string,                       // the game's dist/ folder
 *   game: string,                       // game id, matched by localServed(game) in the page
 *   host: { createRoom(pid: string|null): string, roomInfo(code: string): unknown, connect(code: string, pid: string|null, link: object): void },
 *   normalizeCode?: (raw: string) => string,
 *   port?: number,                      // preferred port; the next free one is used if taken
 *   bind?: string,                      // default 0.0.0.0 (every interface)
 *   name?: string,
 *   log?: (msg: string) => void,
 * }} o
 * @returns {Promise<{ port: number, urls: string[], close(): Promise<void> }>}
 */
export async function serveLan(o) {
  const root = resolve(o.root);
  if (!existsSync(join(root, 'index.html'))) throw new Error(`no index.html in ${root} (build the game first)`);
  const log = o.log ?? ((m) => console.log(m));
  const norm = o.normalizeCode ?? ((s) => s.toUpperCase());
  const inject = `<script>window.__KUNET_LOCAL__=${JSON.stringify({ game: o.game, kind: 'node', name: o.name ?? '' })}</script>`;
  const indexHtml = () => readFileSync(join(root, 'index.html'), 'utf8').replace('<head>', `<head>${inject}`);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    try {
      if (parts[0] === 'api') {
        if (parts[1] !== 'rooms') return sendJson(res, 404, { error: 'not_found' });
        if (parts.length === 2) {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
          const code = o.host.createRoom(url.searchParams.get('pid'));
          log(`[lan] room ${code} created`);
          return sendJson(res, 201, { code });
        }
        const code = norm(decodeURIComponent(parts[2]));
        if (parts.length === 3 && req.method === 'GET') return sendJson(res, 200, code ? o.host.roomInfo(code) : { exists: false });
        return sendJson(res, 404, { error: 'not_found' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' });
      // static files (never outside root)
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      let file = resolve(root, rel || 'index.html');
      if (file !== root && !file.startsWith(root + sep)) return sendJson(res, 403, { error: 'forbidden' });
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) {
        // unknown paths without an extension get the app (?sala= links etc.)
        if (extname(file)) return sendJson(res, 404, { error: 'not_found' });
        file = join(root, 'index.html');
      }
      if (file === join(root, 'index.html')) {
        res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : indexHtml());
      }
      // the web build's service worker is not used on a LAN origin (and must not cache across hosts)
      if (/(^|[/\\])sw\.js$/.test(rel)) return sendJson(res, 404, { error: 'not_found' });
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': /[/\\]assets[/\\]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).pipe(res);
    } catch (e) {
      log(`[lan] ${req.method} ${url.pathname} failed: ${e?.message ?? e}`);
      if (!res.headersSent) sendJson(res, 500, { error: e?.code ?? 'internal' });
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts.length !== 4 || parts[0] !== 'api' || parts[1] !== 'rooms' || parts[3] !== 'ws') return socket.destroy();
    const code = norm(decodeURIComponent(parts[2]));
    wss.handleUpgrade(req, socket, head, (ws) => {
      const link = {
        send: (d) => ws.readyState === ws.OPEN && ws.send(d),
        close: (c, r) => {
          try {
            ws.close(c ?? 1000, r);
          } catch {
            /* already closed */
          }
        },
        onmessage: null,
        onclose: null,
      };
      ws.on('message', (data, isBinary) => {
        if (!isBinary) link.onmessage?.(data.toString());
      });
      ws.on('close', () => link.onclose?.());
      ws.on('error', () => {});
      o.host.connect(code, url.searchParams.get('pid'), link);
    });
  });

  const listen = (port) =>
    new Promise((ok, fail) => {
      const onErr = (e) => {
        server.off('listening', onOk);
        fail(e);
      };
      const onOk = () => {
        server.off('error', onErr);
        ok(server.address().port);
      };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, o.bind ?? '0.0.0.0');
    });
  let port = o.port ?? 8787;
  for (let i = 0; ; i++) {
    try {
      port = await listen(port);
      break;
    } catch (e) {
      if (e?.code !== 'EADDRINUSE' || i >= 20) throw e;
      port++;
    }
  }
  const urls = [`http://localhost:${port}/`, ...lanAddresses().map((a) => `http://${a.address}:${port}/`)];
  return {
    port,
    urls,
    close: () =>
      new Promise((ok) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => ok());
      }),
  };
}
