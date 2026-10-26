'use strict';
/**
 * server/game.js — pure rules engine (no I/O, no timers, no sockets).
 *
 * The single entry point is `resolveRoll(board, position, roll)`, which
 * returns a complete, immutable *move plan*. The room (server/room.js)
 * broadcasts that plan verbatim; every client animates from the same plan
 * (dice tumble → square-by-square hops along `path` → optional snake /
 * ladder slide to `finalPosition`), which is what keeps TV and phones in
 * sync (spec §2 "server is authoritative", §4 "synchronized dice").
 *
 * Rules implemented (spec §3), with assumptions flagged [A#] — all are
 * also listed in docs/ARCHITECTURE.md §6:
 *
 *  R1  Entry: a player off-board (position 0) must roll exactly 6 to
 *      enter. [A1] Entering places the piece ON square 1 — the 6 is spent
 *      on entering, it does not also advance the piece to square 6/7.
 *  R2  Any roll of 6 grants an extra roll, chaining indefinitely —
 *      including the entering 6 (R1) and a 6 that overshoots (R3).
 *  R3  Win: land on 100 with an exact roll. Overshooting (position+roll
 *      > 100) means NO movement; the turn still passes unless R2 applies.
 *      (Note: from squares 95–99 a 6 always overshoots, so R2 grants
 *      re-rolls until a non-6 appears — played as written in the spec.)
 *  R4  Landing on a snake head / ladder bottom transports the piece once.
 *      Chaining into a second feature is impossible by construction:
 *      the board generator guarantees no feature's end is another's
 *      start (see server/board.js rule 3).
 *  R5  A ladder can never end on 100 (generator rule 4), so the only way
 *      to win is an exact dice landing on 100.
 */

const BOARD_SIZE = 100;

/** Roll a fair d6. `rng` injectable for tests. */
function rollDie(rng) {
  return 1 + Math.floor((rng || Math.random)() * 6);
}

/**
 * @param {{snakes:Object, ladders:Object}} board
 * @param {number} position - 0 = off-board, 1..99 on board (100 = finished)
 * @param {number} roll - 1..6
 * @returns {{
 *   roll:number, from:number, entered:boolean, overshot:boolean,
 *   path:number[],            squares hopped through, in order (may be [])
 *   feature:null|{type:'snake'|'ladder', from:number, to:number},
 *   finalPosition:number,     where the piece rests after everything
 *   extraRoll:boolean,        rolled a 6 → same player rolls again (R2)
 *   isWin:boolean
 * }}
 */
function resolveRoll(board, position, roll) {
  const plan = {
    roll, from: position, entered: false, overshot: false,
    path: [], feature: null,
    finalPosition: position,
    extraRoll: roll === 6,   // R2 — true even if the move itself is illegal
    isWin: false,
  };

  // R1 — off-board: only a 6 does anything, and it lands on square 1.
  if (position === 0) {
    if (roll === 6) {
      plan.entered = true;
      plan.path = [1];
      plan.finalPosition = applyFeature(board, 1, plan);
    }
    return plan; // non-6 from off-board: no move, no extra roll
  }

  // R3 — overshoot: piece stays put.
  const target = position + roll;
  if (target > BOARD_SIZE) {
    plan.overshot = true;
    return plan;
  }

  // Normal move: enumerate every square hopped so clients can animate
  // square-by-square (spec §3/§4) without doing any rule math themselves.
  for (let s = position + 1; s <= target; s++) plan.path.push(s);
  plan.isWin = target === BOARD_SIZE;
  plan.finalPosition = plan.isWin ? BOARD_SIZE : applyFeature(board, target, plan);
  return plan;
}

/** R4 — resolve at most one snake/ladder starting on `square`. */
function applyFeature(board, square, plan) {
  if (board.snakes[square] != null) {
    plan.feature = { type: 'snake', from: square, to: board.snakes[square] };
    return board.snakes[square];
  }
  if (board.ladders[square] != null) {
    plan.feature = { type: 'ladder', from: square, to: board.ladders[square] };
    return board.ladders[square];
  }
  return square;
}

/**
 * How long the server waits (ms) before advancing the turn, so the
 * slowest client can finish the shared animation timeline. Clients use
 * the same constants (shared/protocol.js CONFIG) to build their GSAP
 * timelines; "low-effects" mode only ever makes them FASTER, never
 * slower, so this budget always covers them.
 */
function animationBudgetMs(plan, cfg) {
  return cfg.DICE_ANIM_MS
    + plan.path.length * cfg.STEP_MS
    + (plan.feature ? cfg.SLIDE_MS : 0)
    + 450; // settle / network slack
}

module.exports = { rollDie, resolveRoll, animationBudgetMs, BOARD_SIZE };
