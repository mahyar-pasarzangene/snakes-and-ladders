# Architecture & Decision Log — Snakes & Ladders TV Party Game

Companion to the build spec (v2). Section numbers (§) below refer to the spec.

## 1. System shape

```
 ┌──────────────┐  WebSocket (JSON)  ┌──────────────────────────────┐
 │ TV client    │ ◄----------------► │ Node server (authoritative)  │
 │ public/tv    │                    │ server/index.js  HTTP + ws    │
 └──────────────┘                    │ server/room.js   state machine│
 ┌──────────────┐  WebSocket (JSON)  │ server/game.js   pure rules   │
 │ Phone client │ ◄----------------► │ server/board.js  board gen    │
 │ public/mobile│  (× up to 8)      │ Express static + /healthz     │
 └──────────────┘                    └──────────────────────────────┘
        ▲                                        ▲
        └──── shared/protocol.js, public/shared/ ┘
              locales/en.json · locales/fa.json
```

- **Authoritative server (§2).** All dice, movement, timers, win checks run
  server-side. Clients render `room:state` snapshots and `dice:rolled`
  *move plans* (result + every square hopped + optional snake/ladder), so
  TV and phones animate identically and stay in sync.
- **State machine:** `LOBBY → IN_PROGRESS (AWAITING_ROLL → ANIMATING) →
  GAME_OVER`, plus `GAME_OVER → LOBBY` on rematch. Implemented and heavily
  commented in `server/room.js`; pure rules in `server/game.js`.
- **In-memory rooms only** (§2): a `Map<code, Room>`, idle rooms swept
  after 2 h. No database, no accounts. Multiple concurrent rooms are
  supported (each TV creates its own), which makes public hosting sane.
- **No build step for Modes A/C.** The server serves `public/`,
  `shared/`, `locales/` directly. Mode B uses `npm run build:static`.

## 2. Decision log

| # | Decision | Rationale / trade-off |
|---|----------|------------------------|
| D1 | **Raw `ws`** instead of Socket.IO (spec allows either) | Zero client-library weight on weak TV CPUs; native WebSocket exists on all targeted TV Chromium builds. We implement the small pieces we need ourselves: JSON framing, app-level + protocol ping/pong heartbeat, exponential-backoff reconnect, token-based session restore (`public/shared/ws-client.js`). **Trade-off:** no automatic long-polling fallback for pre-WebSocket browsers (flagged as incompatible rather than worked around, per §2.2 spirit). |
| D2 | **Vanilla JS, no framework, conservative syntax** in clients | Spec §2/§5 (TV CPU/RAM). Clients avoid optional chaining etc.; `fetch` has an XHR fallback; board sizing has `vmin` + JS `fitBoard()` fallbacks for engines without CSS `min()`/`aspect-ratio`; CSS logical properties are layered over physical fallbacks where a missing declaration would break layout. |
| D3 | **GSAP 3.15 core only**, bundled locally (72.9 KB min / ~27 KB gzip on compressing hosts) | Per §2.2. Only `x/y/scale/rotation/autoAlpha` are animated; one timeline per move; tweens killed on teardown (`gsap.killTweensOf`, token cleanup); confetti capped at 60 (16 in low-effects). If GSAP fails to load, dice/step logic degrades to timed swaps/snaps — the game still works. |
| D4 | **Server-side QR** (`qrcode` → inline SVG) | TV ships no QR library; the URL always reflects deployment config (see §3). |
| D5 | **Synthesized audio** (Web Audio oscillators/noise, no files) | Tiny, offline-friendly, language-neutral (§4). Lazy `AudioContext` on first gesture; everything degrades silently where WebAudio is absent. Ambient pad + full mute toggle on both clients. |
| D6 | **Animation by server budget, not client acks** | After broadcasting a roll, the server waits `animationBudgetMs(plan)` (dice 1000 ms + 260 ms/square + 800 ms slide + slack) before advancing. Resilient if the TV tab dies; low-effects mode only animates *faster* than the budget, so it can never overrun. |
| D7 | **Move plans over the wire** | `dice:rolled` carries `{roll, path[], feature, finalPosition, extraRoll, isWin}`. Clients do zero rule math — one source of truth, identical timelines. |
| D8 | **Disconnects funnel through the miss rule** | A dead phone's 30 s timer keeps running → miss → after 3 cumulative misses, removal. No special "disconnected player" turn logic to wedge on. Reconnect (playerId + secret token in localStorage) before removal restores the seat, including re-arming the current turn deadline. |
| D9 | **Clock sync via `serverNow`** on state/turn/roll messages | Each client keeps `offset = serverNow − Date.now()` and renders the countdown from the server's `turnEndsAt`. Good to ~RTT accuracy; plenty for a 30 s bar. |
| D10 | **Fonts: Vazirmatn woff2, weights 400/700/900, arabic+latin subsets** | Bundled locally (no CDN; §2.1/§4.1). `unicode-range` means a session downloads only the subset(s) it renders: ≈21 KB/weight arabic, ≈16 KB latin → ≤64 KB for a pure-FA session, ≤49 KB pure-EN. Total on disk 123 KB (both scripts × 3 weights). |
| D11 | **Vazirmatn also covers Latin digits**, and fa digits are produced by a manual ۰–۹ map | Manual mapping avoids relying on old-TV `Intl` having Persian numbering (§4.1). |

## 3. Deployment modes (§2.1) — how each is realized

Environment: `PORT`, `PUBLIC_BASE_URL`, `WS_URL`, `ALLOWED_ORIGINS`,
`SERVE_STATIC` (see `server/config.js`, `.env.example`).

- **Mode A (LAN, single process):** `npm install && npm start`. Express
  serves everything (GSAP, fonts, locales are all local files — no CDN,
  works offline). The QR base URL is resolved as: explicit
  `PUBLIC_BASE_URL` → the **Origin the TV itself connected from** (i.e.
  the LAN address typed into the TV browser — correct even on
  multi-NIC machines where auto-detection guesses wrong) → auto-detected
  LAN IPv4 (192.168/10/172.16 ranked). `localhost` is therefore never
  encoded when reached properly. Console prints the TV URL at boot.
- **Mode B (split):** `WS_URL=wss://… npm run build:static` → deploy
  `dist-static/` to any static host (root = TV, `/join/<CODE>` rewrite →
  mobile; ready-made `netlify.toml`), and run this repo's server with
  `SERVE_STATIC=false` + `ALLOWED_ORIGINS=https://<frontend>` on a
  long-lived host. Browser gets the backend URL from baked `config.js`.
  **Netlify (and similar static/serverless-only hosts) cannot host the
  WebSocket server** — it can only serve the frontend half of Mode B.
- **Mode C (single public host):** deploy the repo/Dockerfile as-is
  (`render.yaml`, `fly.toml` included). Same-origin WS, no CORS.
  `/config.js` is generated by the server from env at request time.

## 4. i18n / RTL approach (§4.1)

- Strings only in `locales/en.json` + `locales/fa.json` (86 keys, parity
  tested). Tiny in-house `t(key, params)` with `{param}` interpolation;
  numeric params auto-formatted (Persian digits under `fa`). Adding a
  language = one new JSON + one entry in `SUPPORTED_LANGS`.
- Server sends **announcement keys + params** (`{key:'announce.snake',
  params:{name}}`), never sentences — each client localizes, including
  mid-game language switches and reconnects.
- TV toggle (EN/فارسی) sets the **room language**, broadcast to all
  phones; reachable in lobby and during play; focusable via D-pad.
  Phones follow it unless the player uses the phone's own toggle
  (sticky per-phone override — assumption A6).
- `<html lang dir>` flips; layouts use CSS logical properties; D-pad
  left/right mirror in RTL. **The board, dice, QR/URL and room code sit
  in `dir="ltr"` islands and are never mirrored** — only board numbers
  re-localize (۱۰۰ on the goal square etc.).
- Player names render with `dir="auto"`/`unicode-bidi: isolate`; name
  input accepts Persian incl. ZWNJ (Vazirmatn's subset covers U+200C),
  max 16 chars.
- Initial language: `localStorage` → `navigator.language` → English,
  remembered per device.

## 5. Performance (§5, §2.2)

- Transform/opacity-only animation; one move timeline; particle caps;
  background drift disabled in low-effects; step/slide durations shrink
  in low-effects.
- **Low-effects mode:** a 3 s rAF FPS probe at boot auto-enables it when
  < 30 fps (session-scoped), plus a manual persisted toggle on the TV.
- Payload (uncompressed): TV ≈ HTML 4 KB + CSS 7 KB + TV JS 26 KB +
  shared JS ~20 KB + GSAP 73 KB + both locales ~11 KB; fonts ≤64 KB per
  language-session. Phone is smaller still. Language switching rewrites
  text in place — no reload, no snapshot re-request.
- Heartbeat also closes half-open sockets so the miss machinery engages
  promptly on Wi-Fi drops.

## 6. Explicit assumptions (spec §6.4 asks for these by name)

| # | Assumption |
|---|-----------|
| A1 | Rolling the entering 6 places the piece **on square 1** (the 6 is spent entering; it does not advance to 6/7). It still grants the extra roll. |
| A2 | Each roll opportunity — including extra rolls from a 6 — gets a **fresh 30 s** window. |
| A3 | Misses are **cumulative across the whole game** (“3 total misses”), never reset. Timer expiry and disconnect expiry are the same event. |
| A4 | If removals leave **one** player, that player wins immediately (“last standing”) instead of playing on alone. Game still ends at the first winner otherwise (no ranking/2nd place). |
| A5 | The TV (host) is a display, not a player. If the TV tab is closed mid-game the room persists on phones until idle-sweep, but the TV cannot re-attach to it — it offers “Create game” again on reconnect. (Same-room TV re-attach could be added via a host token if wanted.) |
| A6 | Phones **follow the room language by default** but keep a small local EN/فارسی override (sticky per phone), per the spec's stated assumption. Remove `langSeg` in `public/mobile` for TV-only control. |
| A7 | Turn order is **shuffled join order** at game start (spec allowed either). |
| A8 | Avatars: player picks a color + animal emoji on the phone; colors are unique per room (server reassigns a taken color to the next free one). |
| A9 | A ladder may **never end on 100** and nothing touches square 1 (generator rule), so the only win is an exact dice roll onto 100, and entering never chain-triggers a feature. Board size: 6–9 snakes & 6–9 ladders, counts within 1, min span 10 squares and ≥1 row crossed. |
| A10 | Lobby seats survive a **60 s grace** after disconnect (phone refresh) before the seat/color are freed. Rematch keeps connected, non-removed players; removed/dropped players must re-join fresh for the next game. |

## 7. Known limitations / flags

- ⚠️ **GSAP/TV engine floor (flagged per §2.2):** GSAP 3.15 and the
  client code assume roughly Chromium ≥ 57-class engines (CSS grid,
  `Array.includes`, Promises) — i.e. Tizen 4+/webOS 4+-era TVs and newer.
  Below that, expect progressive degradation (pulse animation uses the
  CSS `scale` property, silently ignored on old engines; XHR locale
  fallback and `fitBoard()` cover fetch/layout gaps). A truly ancient TV
  (pre-2016) should be tested on-device; if it fails, the fallback path
  is an ES5-transpiled bundle, not included by default to keep the build
  toolchain-free.
- ⚠️ **Persian copy needs native-speaker review** before release (also
  stated in the README). Strings were drafted carefully but are
  unreviewed; glyph shaping/joining should be eyeballed on the target
  TV once.
- No persistence/anti-cheat beyond server authority + reconnect tokens —
  appropriate for a party game; a public deployment inherits room-code
  privacy only (anyone with the code can join a lobby).
- Sound requires a first user gesture (autoplay policies): the TV's
  “Create game” click and the phone's “Join” tap unlock audio.
