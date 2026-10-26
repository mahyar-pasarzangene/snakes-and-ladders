'use strict';
/**
 * server/config.js — deployment configuration (spec §2.1).
 *
 * Everything host-specific comes from the environment so the SAME build
 * runs in Mode A (LAN), B (split) and C (single public host):
 *
 *   PORT             listen port (hosts like Render/Fly inject this)
 *   PUBLIC_BASE_URL  base URL encoded in the QR code, e.g.
 *                    https://snakes.example.com — no trailing slash.
 *                    If unset, the LAN IPv4 is auto-detected (Mode A) so
 *                    phones never receive an unreachable `localhost`.
 *   WS_URL           ws(s):// URL handed to browser clients. Unset =
 *                    same origin (Modes A/C). Set it for Mode B.
 *   ALLOWED_ORIGINS  comma-separated origins allowed to open WS/HTTP
 *                    (Mode B). Unset = same-origin + LAN (permissive).
 *   SERVE_STATIC     'true' (default) serves public/ from this process.
 */
const os = require('os');

/** Best external IPv4: prefer private LAN ranges in a sensible order. */
function detectLanIp() {
  const candidates = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push({ iface, address: a.address });
    }
  }
  const rank = (ip) =>
    ip.startsWith('192.168.') ? 0 :
    ip.startsWith('10.') ? 1 :
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  candidates.sort((a, b) => rank(a.address) - rank(b.address));
  return candidates[0]?.address || '127.0.0.1';
}

function loadConfig(env = process.env) {
  const port = parseInt(env.PORT, 10) || 3000;
  const publicBaseUrl = (env.PUBLIC_BASE_URL || `http://${detectLanIp()}:${port}`)
    .replace(/\/+$/, '');
  return {
    port,
    publicBaseUrl,
    // True when PUBLIC_BASE_URL was explicitly configured. When false,
    // server/index.js prefers the TV connection's Origin for the QR code
    // (the address the TV itself used — correct on LAN and behind
    // proxies/public hosts); `publicBaseUrl` (LAN IP) is the fallback.
    baseUrlExplicit: !!env.PUBLIC_BASE_URL,
    wsUrl: env.WS_URL || null, // null → clients derive from location
    allowedOrigins: env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
      : null,                   // null → accept any origin (LAN default)
    serveStatic: env.SERVE_STATIC !== 'false',
  };
}

module.exports = { loadConfig, detectLanIp };
