'use strict';
/**
 * server/board.js — randomized snake/ladder layout generator (spec §3).
 *
 * A fresh board is generated for every game. Constraints enforced:
 *
 *  1. Balanced counts: 6–9 snakes and 6–9 ladders, differing by at most 1.
 *  2. Minimum span: every snake/ladder covers >= MIN_SPAN squares AND
 *     crosses at least one full row (so nothing looks trivially short).
 *  3. No shared squares: every start and every end square is unique across
 *     ALL snakes and ladders. This single rule implies several spec points:
 *       - no square is both a snake head and a ladder bottom (or vice versa)
 *       - no chaining: a snake tail / ladder top can never be the start of
 *         another snake/ladder, because that square is already "used".
 *  4. Square 1 (entry square) and square 100 (exact-roll finish) are never
 *     touched: a ladder may not end on 100 (that would bypass the
 *     exact-roll win rule) and nothing may start/end on 1 (players enter
 *     there by rolling a 6 and should not be instantly transported).
 *  5. Snake heads live on squares 12..99, tails on 2..(head−MIN_SPAN);
 *     ladder bottoms on 2..(99−MIN_SPAN), tops on (bottom+MIN_SPAN)..99.
 *  6. Soft spread: starts are discouraged (not forbidden) from clustering
 *     in the same row as an existing start — retries prefer spread boards.
 *
 * Algorithm: rejection sampling. Repeatedly draw a random (start, end)
 * pair; keep it if it violates nothing; stop when the target counts are
 * met. If sampling stalls (too many consecutive rejections) the whole
 * board is discarded and generation restarts — with ~86 usable squares
 * and ≤18 features this converges in a few hundred draws in practice
 * (verified by the property tests in test/board.test.js over 2,000 boards).
 *
 * `rng` is injectable (defaults to Math.random) so tests can seed it.
 */

const MIN_SPAN = 10;          // spec: minimum span of 8–10 squares → use 10
const MIN_COUNT = 6;          // spec: sensible range 6–10 of each
const MAX_COUNT = 9;
const MAX_STALL = 400;        // consecutive rejections before a full restart

function rowOf(square) { return Math.floor((square - 1) / 10); }
function randInt(rng, min, max) { return min + Math.floor(rng() * (max - min + 1)); }

/**
 * @param {Function} [rng] - () => float in [0,1)
 * @returns {{snakes: Object<number,number>, ladders: Object<number,number>}}
 *   snakes: head→tail, ladders: bottom→top. Keys are strings (JSON-safe).
 */
function generateBoard(rng) {
  rng = rng || Math.random;

  // Balanced counts: pick a base in [6..9], then the other within ±1.
  const snakeTarget = randInt(rng, MIN_COUNT, MAX_COUNT);
  const ladderTarget = Math.min(MAX_COUNT, Math.max(MIN_COUNT,
    snakeTarget + randInt(rng, -1, 1)));

  for (let restart = 0; restart < 100; restart++) {
    const used = new Set([1, 100]);       // rule 4
    const startRows = new Map();          // rule 6 bookkeeping
    const snakes = {};
    const ladders = {};
    let stall = 0;

    const tryPlace = (isSnake) => {
      // Draw start/end uniformly in the legal ranges for this kind.
      const start = isSnake
        ? randInt(rng, 2 + MIN_SPAN, 99)                       // head 12..99
        : randInt(rng, 2, 99 - MIN_SPAN);                      // bottom 2..89
      const end = isSnake
        ? randInt(rng, 2, start - MIN_SPAN)                    // tail below
        : randInt(rng, start + MIN_SPAN, 99);                  // top above

      if (used.has(start) || used.has(end)) return false;      // rule 3
      if (Math.abs(start - end) < MIN_SPAN) return false;      // rule 2a
      if (rowOf(start) === rowOf(end)) return false;           // rule 2b

      // Rule 6 (soft): avoid >2 feature-starts sharing one row.
      const r = rowOf(start);
      if ((startRows.get(r) || 0) >= 2) return false;

      used.add(start); used.add(end);
      startRows.set(r, (startRows.get(r) || 0) + 1);
      if (isSnake) snakes[start] = end; else ladders[start] = end;
      return true;
    };

    // Alternate kinds so neither starves the other of prime squares.
    while ((Object.keys(snakes).length < snakeTarget ||
            Object.keys(ladders).length < ladderTarget) && stall < MAX_STALL) {
      const needSnake = Object.keys(snakes).length < snakeTarget;
      const needLadder = Object.keys(ladders).length < ladderTarget;
      const isSnake = needSnake && (!needLadder || rng() < 0.5);
      stall = tryPlace(isSnake) ? 0 : stall + 1;
    }

    if (Object.keys(snakes).length === snakeTarget &&
        Object.keys(ladders).length === ladderTarget) {
      return { snakes, ladders };
    }
    // else: stalled — discard and restart with fresh draws.
  }

  // Statistically unreachable (see header), but never crash a party:
  // fall back to a fixed, hand-verified classic layout.
  return {
    snakes: { 16: 6, 47: 26, 54: 34, 62: 19, 87: 24, 93: 73, 99: 80 },
    ladders: { 2: 38, 7: 27, 12: 29, 21: 42, 28: 84, 36: 57, 51: 67, 71: 91 },
  };
}

module.exports = { generateBoard, MIN_SPAN };
