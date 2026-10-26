'use strict';
/** Property tests for the board generator over many seeded boards. */
const { test } = require('node:test');
const assert = require('node:assert');
const { generateBoard } = require('../server/board');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

test('board constraints hold for 2000 generated boards', () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const { snakes, ladders } = generateBoard(mulberry32(seed));
    const ns = Object.keys(snakes).length, nl = Object.keys(ladders).length;

    assert.ok(ns >= 6 && ns <= 9, `snake count ${ns} (seed ${seed})`);
    assert.ok(nl >= 6 && nl <= 9, `ladder count ${nl} (seed ${seed})`);
    assert.ok(Math.abs(ns - nl) <= 1, `balanced counts (seed ${seed})`);

    const used = new Set();
    const check = (map, isSnake) => {
      for (const [s, e] of Object.entries(map)) {
        const start = +s, end = e;
        assert.ok(Math.abs(start - end) >= 10, `min span (seed ${seed})`);
        assert.notStrictEqual(Math.floor((start - 1) / 10), Math.floor((end - 1) / 10), 'crosses a row');
        assert.ok(isSnake ? end < start : end > start, 'direction');
        assert.ok(start >= 2 && start <= 99 && end >= 2 && end <= 99, 'bounds (never 1 or 100)');
        assert.ok(!used.has(start) && !used.has(end), `unique squares ⇒ no chaining (seed ${seed})`);
        used.add(start); used.add(end);
      }
    };
    check(snakes, true);
    check(ladders, false);
  }
});

test('generation is fast (avg well under a frame budget)', () => {
  const t0 = Date.now();
  for (let i = 0; i < 500; i++) generateBoard(mulberry32(i + 7));
  assert.ok((Date.now() - t0) / 500 < 5, 'avg < 5ms per board');
});
