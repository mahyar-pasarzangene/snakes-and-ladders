'use strict';
/** Shared browser dice widget tests: face rendering and stale animation callbacks. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadDice() {
  const intervals = new Map();
  let nextInterval = 1;
  const context = {
    document: {
      createElement() {
        return {
          className: '',
          attributes: {},
          setAttribute(name, value) { this.attributes[name] = String(value); },
        };
      },
    },
    window: {},
    setInterval(callback) {
      const id = nextInterval++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    Math: Object.create(Math),
  };
  context.window.window = context.window;
  context.window.Dice = undefined;
  context.Math.random = () => 0; // deterministic intermediate face = 1
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/shared/dice.js'), 'utf8'), context);

  const el = {
    className: '', attributes: {}, children: [],
    classList: { add() {} },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    appendChild(child) { this.children.push(child); },
  };
  const dice = new context.window.Dice(el);
  return { dice, el, intervals };
}

function visiblePips(dice) {
  return dice.pips.filter((pip) => pip.className.split(' ').includes('on')).length;
}

test('each authoritative d6 result renders exactly that many pips', () => {
  const { dice, el } = loadDice();
  const expected = [1, 2, 3, 4, 5, 6];
  for (const face of expected) {
    assert.equal(dice.setFace(face), true);
    assert.equal(Number(el.attributes['data-face']), face);
    assert.equal(visiblePips(dice), face, `face ${face} must show ${face} pips`);
  }
});

test('roll animation settles on every authoritative result', () => {
  const { dice, el, intervals } = loadDice();
  for (const result of [6, 1, 4, 2, 5, 3]) {
    let completed = 0;
    assert.equal(dice.rollTo(result, 0, () => completed++), true);
    const [id, tick] = [...intervals.entries()][0];
    for (let i = 0; i < 4; i++) tick();
    assert.equal(intervals.has(id), false);
    assert.equal(Number(el.attributes['data-face']), result);
    assert.equal(visiblePips(dice), result);
    assert.equal(completed, 1);
    tick(); // queued duplicate must not replace the settled authoritative face
    assert.equal(Number(el.attributes['data-face']), result);
    assert.equal(visiblePips(dice), result);
    assert.equal(completed, 1);
  }
});

test('superseded and stopped roll callbacks cannot overwrite the latest face', () => {
  const { dice, el, intervals } = loadDice();
  dice.rollTo(2, 1000);
  const oldTick = [...intervals.values()][0];

  dice.rollTo(5, 1000);
  const currentTick = [...intervals.values()][0];
  oldTick(); // simulate an already-queued timer from the prior animation
  assert.equal(Number(el.attributes['data-face']), 6, 'stale callback must do nothing');

  for (let i = 0; i < 11; i++) currentTick();
  assert.equal(Number(el.attributes['data-face']), 5);
  assert.equal(visiblePips(dice), 5);

  dice.rollTo(3, 1000);
  const stoppedTick = [...intervals.values()][0];
  dice.stop();
  stoppedTick();
  assert.equal(Number(el.attributes['data-face']), 5, 'stopped callback must do nothing');
});

test('invalid faces are ignored without blanking or interrupting the current die', () => {
  const { dice, el, intervals } = loadDice();
  dice.setFace(4);
  assert.equal(dice.setFace(0), false);
  assert.equal(dice.setFace(7), false);
  assert.equal(dice.setFace(2.5), false);
  assert.equal(dice.rollTo(0, 500), false);
  assert.equal(Number(el.attributes['data-face']), 4);
  assert.equal(visiblePips(dice), 4);
  assert.equal(intervals.size, 0);
});

// ── snapshot sync: the face a phone must show when it missed the roll ──
// `dice:rolled` is a one-shot broadcast; phones routinely miss it (screen
// lock, backgrounded tab, reload mid-roll, Wi-Fi blip → reconnect) and
// used to keep a stale face while the TV showed the real one.
test('a client that missed the roll adopts the authoritative face from a snapshot', () => {
  const { dice, el, intervals } = loadDice();
  assert.equal(Number(el.attributes['data-face']), 6, 'constructor default');

  assert.equal(dice.syncSnapshot({ id: 3, playerId: 'p1', roll: 2 }), true);
  assert.equal(Number(el.attributes['data-face']), 2);
  assert.equal(visiblePips(dice), 2);
  assert.equal(intervals.size, 0, 'a roll that already happened must not re-animate');

  // Duplicate and older snapshots must never roll the face back.
  assert.equal(dice.syncSnapshot({ id: 3, playerId: 'p1', roll: 2 }), false);
  assert.equal(dice.syncSnapshot({ id: 2, playerId: 'p1', roll: 5 }), false);
  assert.equal(Number(el.attributes['data-face']), 2);
  assert.equal(visiblePips(dice), 2);
});

test('the snapshot that follows dice:rolled cannot cut a running tumble short', () => {
  const { dice, el, intervals } = loadDice();
  dice.rollTo(4, 1000, null, 7); // server's roll id for the running tumble
  const tick = [...intervals.values()][0];
  tick(); tick(); // mid-tumble (random face)
  assert.equal(dice.syncSnapshot({ id: 7, playerId: 'p1', roll: 4 }), false);
  assert.equal(intervals.size, 1, 'tumble still running');
  for (let i = 0; i < 11; i++) tick();
  assert.equal(Number(el.attributes['data-face']), 4);
  assert.equal(visiblePips(dice), 4);
});

test('a newer snapshot overrides an older, still-running tumble', () => {
  const { dice, el, intervals } = loadDice();
  dice.rollTo(2, 1000, null, 4);
  const staleTick = [...intervals.values()][0];
  staleTick();
  // The client missed roll 5 while roll 4 was tumbling (e.g. a socket
  // blip): the authoritative face wins and the stale tumble is stopped.
  assert.equal(dice.syncSnapshot({ id: 5, playerId: 'p1', roll: 3 }), true);
  assert.equal(intervals.size, 0);
  staleTick(); // queued callback from the older tumble
  assert.equal(Number(el.attributes['data-face']), 3);
  assert.equal(visiblePips(dice), 3);
});

test('snapshots without a usable roll leave the die untouched', () => {
  const { dice, el } = loadDice();
  dice.setFace(5);
  assert.equal(dice.syncSnapshot(null), false);
  assert.equal(dice.syncSnapshot({ id: 1 }), false);
  assert.equal(dice.syncSnapshot({ id: 2, roll: 0 }), false);
  assert.equal(dice.syncSnapshot({ id: 3, roll: 9 }), false);
  assert.equal(Number(el.attributes['data-face']), 5);
  assert.equal(visiblePips(dice), 5);
});
