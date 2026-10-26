'use strict';
/**
 * server/index.js — HTTP + WebSocket bootstrap.
 *
 * Single process by design (spec Mode A/C): Express serves the TV and
 * mobile clients, the shared i18n/protocol files and locales; a `ws`
 * server on the same port carries all real-time traffic. In Mode B set
 * SERVE_STATIC=false here and host `npm run build:static` output on a
 * static host — the protocol is identical.
 *
 * Why raw `ws` instead of Socket.IO (spec allows either): zero client
 * library weight on weak TV browsers, native WebSocket everywhere we
 * target, and our reconnect needs are simple (playerId + token). We do
 * our own heartbeat (ping/pong) and exponential-backoff reconnect in
 * public/shared/ws-client.js. Trade-off: no automatic long-polling
 * fallback for truly ancient browsers — see docs/ARCHITECTURE.md §2.
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const SL = require('../shared/protocol');
const { loadConfig } = require('./config');
const { Room, newRoomCode } = require('./room');

const config = loadConfig();
const ROOT = path.join(__dirname, '..');

const app = express();
app.disable('x-powered-by');

// ── CORS (Mode B) ────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (!config.allowedOrigins || config.allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

/**
 * Runtime client config, generated per-deployment (never hard-coded):
 * WS_URL same-origin unless env says otherwise. Mode B's static build
 * bakes an equivalent file instead (scripts/build-static.js).
 */
app.get('/config.js', (_req, res) => {
  res.type('application/javascript').send(
    `window.APP_CONFIG = ${JSON.stringify({ wsUrl: config.wsUrl })};`);
});

if (config.serveStatic) {
  const pub = (p) => path.join(ROOT, 'public', p);
  // Client code and markup must revalidate on every load. Phones keep the
  // page open for a whole party, and the old `maxAge: '1h'` meant a fixed
  // dice.js/mobile.js could go unseen by already-connected players (only
  // the TV, which gets refreshed, picked up a deploy). 'no-cache' still
  // allows a cached copy, but forces an ETag/304 revalidation — cheap on
  // a LAN and correct on every reload. Binary assets (fonts, GSAP) stay
  // long-cached: they don't carry game logic.
  const clientCache = {
    etag: true, lastModified: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  };
  const assetCache = { maxAge: '7d' };
  app.use('/shared', express.static(path.join(ROOT, 'shared'), clientCache));
  app.use('/locales', express.static(path.join(ROOT, 'locales'), clientCache));
  app.use('/vendor', express.static(pub('vendor'), assetCache));
  app.use('/fonts', express.static(pub('fonts'), assetCache));
  app.use('/assets', express.static(pub('shared'), clientCache)); // css/js shared by clients
  app.use('/tv', express.static(pub('tv'), clientCache));
  app.use('/m', express.static(pub('mobile'), clientCache));

  // TV is the landing page; phones land on /join/<CODE> from the QR code.
  // sendFile's default `max-age=0` still lets a phone reuse a stale page
  // without asking; mark both shells as revalidate-always like the assets.
  const page = { headers: { 'Cache-Control': 'no-cache' } };
  app.get('/', (_req, res) => res.sendFile(pub('tv/index.html'), page));
  app.get('/join/:code', (_req, res) => res.sendFile(pub('mobile/index.html'), page));
}

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }, done) => {
    if (config.allowedOrigins && origin && !config.allowedOrigins.includes(origin)) {
      return done(false, 403, 'Origin not allowed');
    }
    done(true);
  },
});

// ── rooms (in-memory only, spec §2 — no database) ────────────────────
const rooms = new Map(); // code → Room
const send = (ws, obj) => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};
const sendError = (ws, key) => send(ws, { type: SL.S2C.ERROR, key });

// Sweep rooms idle for >2h so a public instance doesn't leak memory.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.lastActivityAt < cutoff) { room.destroy(); rooms.delete(code); }
  }
}, 10 * 60 * 1000).unref();

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.origin = req && req.headers ? req.headers.origin : null;
  ws.room = null;        // Room this socket belongs to
  ws.playerId = null;    // set for phones
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { await route(ws, msg); }
    catch (err) { console.error('[ws]', err); sendError(ws, 'error.generic'); }
  });
  ws.on('close', () => { if (ws.room) ws.room.handleDisconnect(ws); });
});

async function route(ws, msg) {
  switch (msg.type) {
    case SL.C2S.PING:
      return send(ws, { type: SL.S2C.PONG, serverNow: Date.now() });

    case SL.C2S.HOST_CREATE: {
      const code = newRoomCode(rooms);
      const room = new Room(code, { send });
      rooms.set(code, room);
      room.attachHost(ws);
      if (SL.CONFIG.SUPPORTED_LANGS.includes(msg.lang)) room.lang = msg.lang;
      ws.room = room;
      // QR base: explicit PUBLIC_BASE_URL wins; otherwise reuse the
      // Origin the TV actually connected from (http/https only), so the
      // phone lands on the same host the TV used. Last resort: LAN IP.
      const originBase = /^https?:\/\/[^\s]+$/.test(ws.origin || '')
        ? ws.origin.replace(/\/+$/, '') : null;
      const base = config.baseUrlExplicit
        ? config.publicBaseUrl
        : (originBase || config.publicBaseUrl);
      const joinUrl = `${base}/join/${code}`;
      // QR rendered server-side as inline SVG: the TV needs no QR library
      // (smaller payload) and the URL always matches PUBLIC_BASE_URL.
      const qrSvg = await QRCode.toString(joinUrl, {
        type: 'svg', margin: 1, width: 320,
        color: { dark: '#1a1033', light: '#ffffff' },
      });
      return send(ws, {
        type: SL.S2C.ROOM_CREATED, roomCode: code, joinUrl, qrSvg,
        state: room.snapshot(),
      });
    }

    case SL.C2S.HOST_START:
      if (!requireHost(ws)) return;
      return reply(ws, ws.room.startGame());

    case SL.C2S.HOST_REMATCH:
      if (!requireHost(ws)) return;
      return reply(ws, ws.room.rematch());

    case SL.C2S.HOST_SET_LANG:
      if (!requireHost(ws)) return;
      return ws.room.setLanguage(msg.lang);

    case SL.C2S.PLAYER_JOIN: {
      const room = rooms.get(String(msg.roomCode || '').toUpperCase());
      if (!room) return sendError(ws, 'error.roomNotFound');
      const { player, error } = room.addPlayer(ws, msg);
      if (error) return sendError(ws, error);
      ws.room = room; ws.playerId = player.id;
      return send(ws, {
        type: SL.S2C.PLAYER_JOINED,
        playerId: player.id, token: player.token,
        state: room.snapshot(),
      });
    }

    case SL.C2S.PLAYER_RECONNECT: {
      const room = rooms.get(String(msg.roomCode || '').toUpperCase());
      if (!room) return sendError(ws, 'error.roomNotFound');
      const { player, error } = room.reconnectPlayer(ws, msg.playerId, msg.token);
      if (error) return sendError(ws, error);
      ws.room = room; ws.playerId = player.id;
      return send(ws, {
        type: SL.S2C.PLAYER_JOINED,
        playerId: player.id, token: player.token,
        state: room.snapshot(),
      });
    }

    case SL.C2S.PLAYER_ROLL:
      if (!ws.room || !ws.playerId) return sendError(ws, 'error.notInGame');
      return reply(ws, ws.room.handleRoll(ws.playerId));

    default:
      return sendError(ws, 'error.generic');
  }
}

function requireHost(ws) {
  if (!ws.room || ws.room.hostWs !== ws) { sendError(ws, 'error.hostOnly'); return false; }
  return true;
}
function reply(ws, result) {
  if (result && result.error) sendError(ws, result.error);
}

// Heartbeat: drop half-open sockets so disconnect→miss logic kicks in.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15_000).unref();

// Bind 0.0.0.0 so LAN devices (and container hosts) can reach us.
server.listen(config.port, '0.0.0.0', () => {
  const base = config.publicBaseUrl;
  console.log('────────────────────────────────────────────────────────');
  console.log(' 🎲 Snakes & Ladders party server');
  console.log(` 📺 TV display : ${base}/`);
  console.log(` 📱 Phones join via the QR code shown on the TV`);
  console.log(` 🔌 WebSocket  : ${config.wsUrl || '(same origin)'}`);
  console.log(` 🌐 Base URL   : ${base}  ${process.env.PUBLIC_BASE_URL ? '(from PUBLIC_BASE_URL)' : '(auto-detected LAN IP)'}`);
  console.log('────────────────────────────────────────────────────────');
});
