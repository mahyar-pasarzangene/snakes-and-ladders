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
