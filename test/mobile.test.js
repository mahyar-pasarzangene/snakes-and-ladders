'use strict';
/**
 * Mobile controller integration tests.
 *
 * Runs the REAL public/mobile/mobile.js (plus shared/protocol.js,
 * shared/dice.js and shared/ws-client.js) against a fake DOM, fake timers
 * and a fake WebSocket, so we can push exactly the messages the server
 * sends and inspect the phone's die.
 *
 * Regression: `dice:rolled` is a one-shot broadcast. A phone that was
 * asleep, backgrounded, reloaded mid-roll or briefly offline (Wi-Fi blip →
 * reconnect) used to keep the previous face — or the constructor default 6
 * — while the TV showed the real result. Every snapshot now carries
 * `lastRoll` and the phone adopts it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── minimal DOM ──────────────────────────────────────────────────────
function makeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '', hidden: false, textContent: '', value: '', disabled: false,
    children: [], attributes: {}, listeners: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] == null ? null : this.attributes[name]; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i !== -1) this.children.splice(i, 1);
      return child;
    },
    get firstChild() { return this.children[0] || null; },
    remove() {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    set innerHTML(v) { if (!v) this.children.length = 0; },
    get innerHTML() { return ''; },
  };
  Object.defineProperty(el, 'className', {
    get() { return [...classes].join(' '); },
    set(v) {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
  });
  return el;
}

/** vm sandbox running the real client scripts with fake network/timers. */
function bootPhone() {
  const elements = new Map();
  const timers = new Map();       // fake setInterval/setTimeout callbacks
  let timerId = 0;

  const sandbox = {
    console,
    Math, Date, JSON, Number, String, Object, Array, Boolean, Error, Promise,
    document: {
      getElementById(id) {
        if (!elements.has(id)) { const el = makeEl('div'); el.id = id; elements.set(id, el); }
        return elements.get(id);
      },
      createElement: (tag) => makeEl(tag),
      documentElement: makeEl('html'),
      body: makeEl('body'),
      addEventListener() {},
    },
    location: { pathname: '/join/TEST1', protocol: 'http:', host: 'tv.local', search: '' },
    history: { replaceState() {} },
    localStorage: (() => {
      const store = new Map();
      return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      };
    })(),
    navigator: {},
    requestAnimationFrame() {},
    setInterval(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearInterval(id) { timers.delete(id); },
    clearTimeout(id) { timers.delete(id); },
    // i18n stub: keys + params stay visible so assertions can read them.
    I18n: {
      lang: 'en',
      t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
      fmt: (n) => String(n),
      apply() {},
      detect: () => 'en',
      onChange() {},
      setLang: () => Promise.resolve(),
    },
    Sound: {
      dice() {}, turn() {}, win() {}, join() {}, miss() {}, step() {}, snake() {},
      unlock() {}, isMuted: () => false, setMuted() {},
    },
    WebSocket: class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.sent = [];
        FakeWebSocket.last = this;
      }
      send(data) { this.sent.push(JSON.parse(data)); }
      close() { if (this.onclose) this.onclose({}); }
      // test helpers
      open() { if (this.onopen) this.onopen(); }
      receive(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
    },
    APP_CONFIG: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const file of [
    'shared/protocol.js',
    'public/shared/dice.js',
    'public/shared/ws-client.js',
    'public/mobile/mobile.js',
  ]) vm.runInContext(read(file), sandbox, { filename: file });

  const sock = sandbox.WebSocket.last;
  assert.ok(sock, 'mobile client opened a socket on boot');
  sock.open();

  const el = (id) => sandbox.document.getElementById(id);
  return {
    sandbox, sock, el, timers,
    /** run every pending interval callback `n` times (dice tumble). */
    ticks(n) {
      for (let i = 0; i < n; i++) [...timers.values()].forEach((fn) => fn());
    },
    lastSent(type) { return sock.sent.filter((m) => m.type === type).pop(); },
  };
}

function state(overrides) {
  return Object.assign({
    roomCode: 'TEST1',
    phase: 'IN_PROGRESS',
    turnPhase: 'AWAITING_ROLL',
    lang: 'en',
    board: null,
    turnPlayerId: 'p1',
    turnEndsAt: Date.now() + 30000,
    serverNow: Date.now(),
    winnerId: null,
    lastRoll: null,
    players: [
      { id: 'me', name: 'Ali', colorId: 0, avatar: '🦁', position: 12, misses: 0, connected: true, removed: false },
      { id: 'p1', name: 'Sara', colorId: 1, avatar: '🦊', position: 20, misses: 0, connected: true, removed: false },
    ],
  }, overrides);
}

/** Join the room the way the TV-driven flow does, then hand over state. */
function joinedPhone(s) {
  const phone = bootPhone();
  phone.sock.receive({ type: 'player:joined', playerId: 'me', token: 'tok', state: state({ phase: 'LOBBY', turnPlayerId: null }) });
  if (s) phone.sock.receive({ type: 'room:state', state: s });
  return phone;
}

test('a phone that missed the roll shows the authoritative face from the snapshot', () => {
  // Reconnect mid-animation: no `dice:rolled` on this socket, only state.
  const phone = joinedPhone(state({
    turnPhase: 'ANIMATING',
    lastRoll: { id: 7, playerId: 'p1', roll: 3 },
  }));

  assert.equal(phone.el('diceEl').getAttribute('data-face'), '3');
  assert.equal(
    phone.el('diceEl').className.split(' ').includes('face-3'), true,
    'die class matches the face');
  const line = phone.el('statusLine').textContent;
  assert.match(line, /^play\.rolledInfo:/, 'explains whose roll the TV is showing');
  assert.match(line, /"roll":3/, 'and the value');
});

test('the snapshot that follows dice:rolled does not disturb the phone tumble', () => {
  const phone = joinedPhone(state({ turnPhase: 'AWAITING_ROLL' }));

  phone.sock.receive({
    type: 'dice:rolled',
    rollId: 8,
    playerId: 'p1',
    plan: { roll: 5, from: 20, path: [21, 22, 23, 24, 25], finalPosition: 25 },
  });
  phone.sock.receive({ type: 'room:state', state: state({
    turnPhase: 'ANIMATING',
    lastRoll: { id: 8, playerId: 'p1', roll: 5 },
  }) });

  assert.ok(phone.timers.size > 0, 'tumble still running after the snapshot');
  phone.ticks(11);
  assert.equal(phone.el('diceEl').getAttribute('data-face'), '5');
});

test('a roll this phone missed mid-tumble wins over the older animation', () => {
  const phone = joinedPhone(state({ turnPhase: 'AWAITING_ROLL' }));

  phone.sock.receive({
    type: 'dice:rolled',
    rollId: 8,
    playerId: 'p1',
    plan: { roll: 2, from: 20, path: [21, 22], finalPosition: 22 },
  });
  phone.ticks(2); // mid-tumble
  // Next roll happened while this phone was reconnecting.
  phone.sock.receive({ type: 'room:state', state: state({
    turnPhase: 'ANIMATING',
    lastRoll: { id: 9, playerId: 'p1', roll: 4 },
  }) });

  assert.equal(phone.el('diceEl').getAttribute('data-face'), '4');
  phone.ticks(12); // any queued ticks from the stale tumble
  assert.equal(phone.el('diceEl').getAttribute('data-face'), '4');
});

test('a late arrival on the join form still sees the current face', () => {
  // No roll in this room yet: the die keeps its neutral default face and
  // no status line is fabricated.
  const phone = joinedPhone(state({ phase: 'LOBBY', turnPlayerId: null }));
  assert.equal(phone.el('diceEl').getAttribute('data-face'), '6');
  phone.sock.receive({ type: 'room:state', state: state({ lastRoll: null }) });
  assert.equal(phone.el('diceEl').getAttribute('data-face'), '6');
});
