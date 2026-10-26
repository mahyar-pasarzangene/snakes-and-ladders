'use strict';
/**
 * scripts/build-static.js — Mode B build (spec §2.1).
 *
 * Produces `dist-static/` for a static host (Netlify / Vercel /
 * Cloudflare Pages / GitHub Pages): TV files at the root, the mobile
 * client as join/index.html (so /join/<CODE> needs a rewrite — see
 * netlify.toml / README), plus shared/, locales/, vendor/, fonts/ and a
 * generated config.js pointing at WS_URL.
 *
 * Usage:  WS_URL=wss://your-backend.onrender.com npm run build:static
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'dist-static');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// TV client at site root; mobile under /m and /join (rewrite target).
copyDir(path.join(root, 'public', 'tv'), out);
copyDir(path.join(root, 'public', 'mobile'), path.join(out, 'm'));
fs.mkdirSync(path.join(out, 'join'), { recursive: true });
fs.copyFileSync(path.join(root, 'public', 'mobile', 'index.html'),
                path.join(out, 'join', 'index.html'));

// Absolute paths in the HTML (/assets, /shared, /tv…) map to these dirs:
copyDir(path.join(root, 'public', 'shared'), path.join(out, 'assets'));
copyDir(path.join(root, 'public', 'tv'), path.join(out, 'tv'));
copyDir(path.join(root, 'public', 'mobile'), path.join(out, 'm'));
copyDir(path.join(root, 'shared'), path.join(out, 'shared'));
copyDir(path.join(root, 'locales'), path.join(out, 'locales'));
copyDir(path.join(root, 'public', 'vendor'), path.join(out, 'vendor'));
copyDir(path.join(root, 'public', 'fonts'), path.join(out, 'fonts'));

const wsUrl = process.env.WS_URL || null;
fs.writeFileSync(path.join(out, 'config.js'),
  `window.APP_CONFIG = ${JSON.stringify({ wsUrl })};\n`);

console.log('Static build → dist-static/  (WS_URL =', wsUrl || 'same-origin', ')');
if (!wsUrl) console.warn('⚠️  WS_URL unset: clients will try same-origin WebSocket. ' +
  'For Mode B set WS_URL=wss://<your-backend-host>');
