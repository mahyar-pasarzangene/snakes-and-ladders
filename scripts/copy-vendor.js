/**
 * Copies third-party browser assets out of node_modules into public/ so the
 * game works fully offline on a LAN (no CDN, no Google Fonts — spec §2.1).
 * Runs automatically on `npm install` (postinstall). The copied files are
 * committed to the repo so `npm start` also works on hosts that prune
 * devDependencies.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

function copy(src, dest) {
  const s = path.join(root, src);
  if (!fs.existsSync(s)) { console.warn('[copy-vendor] missing, skipped:', src); return; }
  fs.mkdirSync(path.dirname(path.join(root, dest)), { recursive: true });
  fs.copyFileSync(s, path.join(root, dest));
  console.log('[copy-vendor]', src, '->', dest);
}

// GSAP 3 core only (spec §2.2 — no plugins).
copy('node_modules/gsap/dist/gsap.min.js', 'public/vendor/gsap.min.js');

// Vazirmatn (Persian-capable, OFL) — woff2 only, weights 400/700/900,
// arabic + latin subsets. unicode-range in fonts.css means a browser only
// downloads the subset(s) it actually renders (~24 KB per weight, arabic).
for (const subset of ['arabic', 'latin']) {
  for (const w of [400, 700, 900]) {
    const f = `vazirmatn-${subset}-${w}-normal.woff2`;
    copy(`node_modules/@fontsource/vazirmatn/files/${f}`, `public/fonts/${f}`);
  }
}
