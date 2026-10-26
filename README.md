# 🎲 Snakes & Ladders — Multiplayer TV Party Game

A browser-based party game: the **TV is the board**, **phones are the
controllers**. 2–8 players scan a QR code, join on their phones, and roll
the die from the couch while everyone watches the big screen. Fully
bilingual **English / فارسی (Persian)**, works on your **home Wi-Fi (no
internet needed)** or hosted publicly.

```
📺 TV browser  ──WebSocket──►  Node server (authoritative)  ◄──WebSocket──  📱 phones ×2–8
```

Rules: roll a **6 to enter** the board · every 6 rolls again (chains
forever) · land **exactly on 100** to win (overshoot = no move) · 30 s
per turn · 3 missed turns and you're out · board layout is **randomly
generated fresh every game**.

> ⚠️ **Persian translations:** drafted with care, but they should be
> **reviewed by a native Persian speaker** before a public release.
> All strings live in [`locales/fa.json`](locales/fa.json) / [`locales/en.json`](locales/en.json).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the decision log,
state-machine details, and every assumption made where the spec left room.

---

## Quick start — Mode A: play at home on your Wi-Fi (recommended)

One command on any laptop / PC / Raspberry Pi on the same Wi-Fi as the TV:

```bash
npm install
npm start
```

The console prints something like:

```
 🎲 Snakes & Ladders party server
 📺 TV display : http://192.168.1.20:3000/
```

1. Open that URL in the **Smart TV browser** (or any big screen).
2. Click **Create game** — a QR code + room code appear.
3. Players scan the QR with their phone cameras (or type the URL),
   pick a name, color, and character, and join.
4. Press **Start game** on the TV. Each player rolls from their phone.

**How the address/QR is determined:** if `PUBLIC_BASE_URL` is unset, the
server auto-detects its LAN IPv4 (192.168.x preferred), prints it, and —
more precisely — the QR code reuses **the address you opened on the TV**
itself, so it stays correct on machines with multiple network cards.
`localhost` is never knowingly encoded (phones can't reach it). To force
an address: `PUBLIC_BASE_URL=http://192.168.1.20:3000 npm start`.

Everything (fonts, GSAP, sounds) is bundled locally — **no CDN, no
Google Fonts**, so Mode A works with the internet unplugged.

### LAN troubleshooting

- **Phones can't open the join URL:** most often the router has
  **AP isolation / client isolation / guest-network isolation** enabled,
  which blocks Wi-Fi clients from talking to each other. Turn it off, or
  move TV + phones + server onto the same non-guest SSID. Also check:
  server machine firewall must allow inbound TCP on the port (3000);
  phones must be on the same subnet (same first three IP groups, e.g.
  all `192.168.1.x`); some "Wi-Fi extenders" create a second subnet.
- **TV browser too old / page looks wrong:** press the **Low effects**
  toggle on the TV (top corner) — the TV also auto-enables it when the
  frame rate is low. Very old TVs (pre-2016) may not run the game; see
  the engine note in `docs/ARCHITECTURE.md` §7.
- **No sound until you click something:** normal browser autoplay rule —
  the first click (Create game / Join) unlocks audio. 🔊 toggles mute.
- **TV remote:** arrow keys (D-pad) move focus between controls, **OK**
  presses them. Language/sound/low-effects live in the top bar and are
  reachable during play.

### Local development

```bash
npm run dev     # server with --watch (auto-restart on changes)
npm test        # board-generator property tests + rules/state-machine tests
```

Open `http://localhost:3000` (TV) and `http://localhost:3000/join/<CODE>`
in a second tab/window (phone). Node ≥ 18. No build step.

---

## Internet hosting

### Mode C — single host (simplest public option)

Deploy this repo as one Node service; it serves the frontend **and** the
WebSocket server on one origin (no CORS config):

- **Render:** repo includes [`render.yaml`](render.yaml) (New → Blueprint).
- **Fly.io:** repo includes [`fly.toml`](fly.toml) + [`Dockerfile`](Dockerfile)
  (`fly launch --copy-config`, then `fly deploy`).
- **Any VPS/Pi with a public address:** `npm ci && PORT=3000 npm start`
  behind your HTTPS reverse proxy (the app must be served over
  HTTPS/WSS in production — the host/proxy terminates TLS).

Optionally set `PUBLIC_BASE_URL=https://your-domain` so QR codes are
exact (otherwise the address the TV used is reused). `PORT` is honored,
and `/healthz` is provided for health checks.

### Mode B — split hosting (static frontend + separate WebSocket backend)

1. Deploy the server (backend only):
   `SERVE_STATIC=false ALLOWED_ORIGINS=https://your-frontend.example npm start`
   on a host that runs long-lived Node (below).
2. Build the frontend:
   `WS_URL=wss://your-backend.example npm run build:static`
3. Upload `dist-static/` to your static host, and make sure
   **`/join/<CODE>` is rewritten to `/join/index.html`**
   (ready-made [`netlify.toml`](netlify.toml) included; Vercel/Cloudflare
   Pages equivalents are a single rewrite rule).
4. Set `PUBLIC_BASE_URL=https://your-frontend.example` on the **backend**
   (that's what the QR encodes).

> 🚫 **Netlify, Vercel, Cloudflare Pages, and GitHub Pages host static
> files and short-lived functions only — they cannot run the always-on
> WebSocket server.** They can host the *frontend half* of Mode B, never
> the game server itself.

### Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | Listen port | `3000` |
| `PUBLIC_BASE_URL` | Base URL encoded in the QR code | auto: TV's own origin → detected LAN IP |
| `WS_URL` | WebSocket URL given to browsers (Mode B) | same origin |
| `ALLOWED_ORIGINS` | Comma-separated CORS/WS origin allowlist (Mode B) | any origin |
| `SERVE_STATIC` | `false` = backend-only (Mode B) | `true` |

Client HTML/JS/CSS is served with `Cache-Control: no-cache` (+ETag, so the
revalidation is a cheap 304) while fonts/GSAP stay long-cached: phones keep
the page open for a whole party, and they must pick up a new `dice.js` /
`mobile.js` on their next load instead of running yesterday's copy. A phone
that was already on a stale page just needs one refresh after a deploy.

---

## Best free hosting options *(checked 26 Oct 2026 — free tiers change often; re-verify before you rely on them)*

What matters for this game specifically: the backend is a **stateful,
long-lived WebSocket process** with in-memory rooms. Idle spin-down is OK
*between* parties but a host must never sleep mid-game (our clients ping
every 20 s, which counts as traffic on these platforms, so a live game
keeps the service awake). Cold start only hurts whoever opens the TV page
first.

### (a) WebSocket backend (the hard part)

| Host | Free tier (Oct 2026) | Sleep / cold start | Card? | Fit for this game |
|---|---|---|---|---|
| **Render** (web service) | Free: 512 MB RAM, 0.1 CPU, 750 instance-hours/month per workspace, ~5 GB bandwidth/month on the free Hobby workspace | **Spins down after ~15 min idle; ~1 min to wake** on the next request | No | ✅ **Best truly-free option.** Wake-up delay hits only the first TV page load; pings keep it awake during play. WebSockets supported. Blueprint included. |
| **Fly.io** | **No free tier for new accounts** (pay-as-you-go; tiny intro trial) | With `auto_stop_machines`, idle cost ≈ $0; wake ~1–2 s. A 256 MB always-on machine ≈ $2/mo | **Yes** | ✅ Best "almost-free, feels instant" option if you can put a card down. Config included. |
| **Railway** | No ongoing free tier: one-time $5 trial credit (~30 days), then a token $1/month credit; Hobby is $5/month including $5 of usage | Always-on by default (no sleep) on paid usage | No for trial | ⚠️ Fine to *try* for free for a month; effectively $5/mo after. Effortless deploys, real WebSockets. |

Honest summary: in 2026 there is **no unlimited free always-on backend**
from the big names. Your real choices are *free but sleeps* (Render),
*pennies but instant* (Fly.io auto-stop), or *$5/mo flat* (Railway Hobby /
Render Starter $7/mo always-on).

### (b) Static frontend (only needed for Mode B)

| Host | Free tier (Oct 2026) | Gotchas |
|---|---|---|
| **Cloudflare Pages** | Unlimited static bandwidth/requests, 500 builds/month | Most generous; no card. (Pages *Functions* are capped at 100k req/day, but you don't need them here.) |
| **Netlify** | 300 credits/month for new accounts (≈15 GB bandwidth at 20 credits/GB; each production deploy costs 15) — site pauses at 0 credits | Credit math surprises people; still plenty for a party game. |
| **Vercel (Hobby)** | 100 GB transfer, 1M edge requests | **Personal/non-commercial use only** on Hobby. |
| **GitHub Pages** | Free, ~100 GB/month soft bandwidth limit | Static only, no rewrites file — `/join/<CODE>` needs the `join/index.html` copy our build already emits, but arbitrary codes 404 unless you add a `404.html` trick; least smooth of the four for this app. |

### Recommendations

- **(i) Occasional home / party use:** **Mode A on your own Wi-Fi** —
  it's free forever, lowest latency, and works with no internet at all.
  If friends must join from outside your home, **Mode C on Render free**:
  $0, no card; just open the TV page a minute early to absorb the
  cold start.
- **(ii) Always-available public link:** **Mode C on Fly.io** with the
  included `fly.toml` (auto-stop: near-zero idle cost, ~1–2 s wake,
  card required), or Render Starter ($7/mo) if you want zero cold starts
  ever. In Mode C the same service serves the frontend, so you don't
  need a separate static host at all.

---

## Languages (EN / فارسی) & adding your own

- **Switch on the TV:** the **EN / فارسی** toggle in the top bar sets the
  *room* language and instantly re-renders the TV **and every phone**
  (including mid-game). Persian switches the UI to RTL and numbers to
  Persian digits (۰–۹) everywhere — board squares included — but the
  board layout itself is never mirrored, exactly like a printed board.
  Each phone also has its own small toggle if one player prefers the
  other language.
- The choice is remembered per device (`localStorage`); first visit
  follows the browser language, defaulting to English.
- **Add a language:** copy `locales/en.json` → `locales/<code>.json`,
  translate the values, add `<code>` to `SUPPORTED_LANGS` in
  [`shared/protocol.js`](shared/protocol.js), and add a button with
  `data-lang="<code>"` to the TV/phone toggle markup. No other code
  changes — server announcements are sent as translation keys, never as
  sentences. (An RTL language additionally needs its code added to the
  `dir` check in `public/shared/i18n.js`.)

---

## Project layout

```
server/            Node server (authoritative)
  index.js         HTTP + WebSocket bootstrap, QR codes, static serving
  config.js        env config + LAN IP detection
  room.js          turn / timer / disconnect state machine (commented)
  game.js          pure rules: resolveRoll() → move plan (commented)
  board.js         randomized board generator (commented)
shared/protocol.js wire protocol + game constants (server AND browsers)
locales/           en.json · fa.json  (all UI strings; server sends keys)
public/
  tv/              TV display client (board, GSAP timelines, D-pad nav)
  mobile/          phone controller client (join form, ROLL button)
  shared/          i18n.js · ws-client.js · dice.js · sound.js (WebAudio)
  vendor/          GSAP 3 core (bundled — no CDN)
  fonts/           Vazirmatn woff2 subsets (bundled — no Google Fonts)
scripts/           copy-vendor.js (postinstall) · build-static.js (Mode B)
test/              board property tests (2,000 boards) · rules/room state
                   machine · shared dice widget · mobile client (fake DOM)
docs/ARCHITECTURE.md   decision log, assumptions A1–A10, limitations
```

## License

Game code: MIT. Bundled third parties: GSAP (standard GreenSock license,
free for this use), Vazirmatn font (SIL Open Font License).
