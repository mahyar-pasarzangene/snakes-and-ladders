'use strict';
/** Rules + room state-machine tests (no sockets: Room io is stubbed). */
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveRoll } = require('../server/game');
const { Room } = require('../server/room');
const SL = require('../shared/protocol');

const board = { snakes: { 30: 5 }, ladders: { 4: 40 } };

test('off-board: only a 6 enters, landing on square 1, and it re-rolls', () => {
  const no = resolveRoll(board, 0, 4);
  assert.strictEqual(no.finalPosition, 0);
  assert.strictEqual(no.extraRoll, false);

  const yes = resolveRoll(board, 0, 6);
  assert.strictEqual(yes.entered, true);
  assert.strictEqual(yes.finalPosition, 1);
  assert.deepStrictEqual(yes.path, [1]);
  assert.strictEqual(yes.extraRoll, true);
});

test('overshoot: no move; a 6 still grants the extra roll', () => {
  const p = resolveRoll(board, 98, 5);
  assert.strictEqual(p.overshot, true);
  assert.strictEqual(p.finalPosition, 98);
  assert.strictEqual(p.extraRoll, false);

  const p6 = resolveRoll(board, 97, 6);
  assert.strictEqual(p6.overshot, true);
  assert.strictEqual(p6.extraRoll, true);
});

test('exact 100 wins; snakes and ladders apply once with a full path', () => {
  const win = resolveRoll(board, 96, 4);
  assert.strictEqual(win.isWin, true);
  assert.deepStrictEqual(win.path, [97, 98, 99, 100]);

  const snake = resolveRoll(board, 27, 3);
  assert.deepStrictEqual(snake.feature, { type: 'snake', from: 30, to: 5 });
  assert.strictEqual(snake.finalPosition, 5);

  const ladder = resolveRoll(board, 1, 3);
  assert.deepStrictEqual(ladder.feature, { type: 'ladder', from: 4, to: 40 });
  assert.strictEqual(ladder.finalPosition, 40);
});

// ── Room state machine with stubbed sockets + scripted dice ──────────
function fakeWs() { return { OPEN: 1, readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); } }; }
function makeRoom(rolls) {
  const sent = [];
  const io = { send: (ws, obj) => ws && ws.send(JSON.stringify(obj)) };
  let i = 0;
  // rng scripted so rollDie() returns rolls in sequence (values 1..6 →
  // bucket midpoints); board generation/shuffle consume rng first, so we
  // only script the die via a dedicated counter trick below.
  const room = new Room('TEST1', io);
  room.rng = Math.random;
  return { room, nextRoll: () => rolls[i++ % rolls.length] };
}

test('room: joins enforce lobby + unique colors; start needs ≥2 players', () => {
  const { room } = makeRoom([]);
  const tv = fakeWs(); room.attachHost(tv);
  assert.strictEqual(room.startGame().error, 'error.needTwoPlayers');

  const w1 = fakeWs(), w2 = fakeWs();
  const a = room.addPlayer(w1, { name: 'Ali', colorId: 0, avatar: '🦁' });
  const b = room.addPlayer(w2, { name: 'Sara', colorId: 0, avatar: '🦊' });
  assert.ok(a.player && b.player);
  assert.notStrictEqual(a.player.colorId, b.player.colorId, 'color re-assigned when taken');

  assert.deepStrictEqual(room.startGame(), {});
  assert.strictEqual(room.phase, SL.Phase.IN_PROGRESS);
  assert.ok(room.board, 'board generated at start');
  assert.strictEqual(room.addPlayer(fakeWs(), { name: 'Late', colorId: 3 }).error,
    'error.gameInProgress', 'no joining mid-game');
  room.destroy();
});

test('room: wrong-player rolls rejected; timeout → miss; 3 misses → removal + elimination win', () => {
  const { room } = makeRoom([]);
  room.attachHost(fakeWs());
  const a = room.addPlayer(fakeWs(), { name: 'A', colorId: 0 });
  const b = room.addPlayer(fakeWs(), { name: 'B', colorId: 1 });
  room.startGame();

  const current = room.currentPlayerId();
  const other = current === a.player.id ? b.player.id : a.player.id;
  assert.strictEqual(room.handleRoll(other).error, 'error.notYourTurn');

  // Expire turns until someone collects 3 misses. Each timeout rotates:
  // A,B,A,B… so the player who times out 3rd is removed, leaving 1 → win.
  for (let i = 0; i < 6 && room.phase === SL.Phase.IN_PROGRESS; i++) {
    room.onTurnTimeout();
  }
  assert.strictEqual(room.phase, SL.Phase.GAME_OVER);
  assert.ok(room.winnerId, 'last remaining player wins by elimination [A4]');
  const removed = [...room.players.values()].find(p => p.removed);
  assert.ok(removed && removed.misses >= 3);
  assert.strictEqual(room.reconnectPlayer(fakeWs(), removed.id, removed.token).error,
    'error.reconnectFailed', 'removed players cannot reconnect');
  room.destroy();
});

test('room: reconnect with token restores the seat before removal', () => {
  const { room } = makeRoom([]);
  room.attachHost(fakeWs());
  const a = room.addPlayer(fakeWs(), { name: 'A', colorId: 0 });
  room.addPlayer(fakeWs(), { name: 'B', colorId: 1 });
  room.startGame();

  const ok = room.reconnectPlayer(fakeWs(), a.player.id, a.player.token);
  assert.ok(ok.player, 'valid token reconnects');
  const bad = room.reconnectPlayer(fakeWs(), a.player.id, 'wrong');
  assert.strictEqual(bad.error, 'error.reconnectFailed');
  room.destroy();
});

test('room: every snapshot carries the authoritative face for phones that missed the roll', () => {
  const { room } = makeRoom([]);
  room.attachHost(fakeWs());
  room.addPlayer(fakeWs(), { name: 'A', colorId: 0 });
  const bWs = fakeWs();
  room.addPlayer(bWs, { name: 'B', colorId: 1 });
  room.startGame();
  room.rng = () => 0.99; // rollDie() → 6

  const roller = room.currentPlayerId();
  assert.deepStrictEqual(room.handleRoll(roller), {});

  const snap = room.snapshot();
  assert.ok(snap.lastRoll, 'snapshot carries the last roll');
  assert.strictEqual(snap.lastRoll.roll, 6);
  assert.strictEqual(snap.lastRoll.playerId, roller);
  const rolled = bWs.sent.filter((m) => m.type === SL.S2C.DICE_ROLLED).pop();
  assert.strictEqual(rolled.rollId, snap.lastRoll.id, 'dice:rolled and room:state agree');

  // A phone that reconnects mid-animation is handed the face it missed.
  const rollerRec = [...room.players.values()].find((p) => p.id === roller);
  const backWs = fakeWs();
  assert.ok(room.reconnectPlayer(backWs, rollerRec.id, rollerRec.token).player);
  const stateMsg = backWs.sent.filter((m) => m.type === SL.S2C.STATE).pop();
  assert.deepStrictEqual(stateMsg.state.lastRoll, snap.lastRoll);

  // A new game clears the face, but ids stay monotonic so an old snapshot
  // can never overwrite a newer roll on any client.
  room.endGame(null, 'elimination');
  room.rematch();
  assert.strictEqual(room.snapshot().lastRoll, null);
  assert.deepStrictEqual(room.startGame(), {});
  assert.strictEqual(room.snapshot().lastRoll, null, 'nothing rolled yet in the new game');
  room.handleRoll(room.currentPlayerId());
  const next = room.snapshot().lastRoll;
  assert.ok(next.id > snap.lastRoll.id, 'roll ids are monotonic across games');
  assert.strictEqual(next.roll, 6);
  room.destroy();
});
