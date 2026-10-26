'use strict';
/**
 * server/room.js — one game room: the turn/disconnect STATE MACHINE.
 *
 *  ┌────────┐  host:start   ┌─────────────────────────────────┐
 *  │ LOBBY  │ ────────────► │ IN_PROGRESS                     │
 *  └────────┘  (≥2 players) │   AWAITING_ROLL ──roll──►       │
 *       ▲                   │        ▲            ANIMATING   │
 *       │ host:rematch      │        └────budget elapsed──────┘
 *       │                   └──────────────┬──────────────────┘
 *       │                                  │ exact land on 100,
 *       └──────────────────────────────────┤ or 1 player left  [A4]
 *                                          ▼
 *                                     GAME_OVER
 *
 * Turn timer & misses (spec §3):
 *  - Each AWAITING_ROLL window lasts TURN_SECONDS (30s). [A2] An extra
 *    roll earned by a 6 opens a FRESH 30s window.
 *  - Expiry = one "miss" for the current player; the turn passes.
 *  - Misses are CUMULATIVE for the whole game ("3 total misses", spec
 *    wording) — they never reset. At MAX_MISSES (3) the player is
 *    REMOVED: announced to the room, skipped in rotation forever,
 *    token revoked (no reconnect after removal).
 *  - A disconnected player's timer keeps running. That is deliberate:
 *    disconnects flow through exactly the same miss → removal path as
 *    idle timeouts, so a dead phone can never wedge the game. Reconnect
 *    (same playerId + secret token) before removal restores everything.
 *  - [A4] The spec ends the game on the first winner; it is silent about
 *    eliminations reducing the game to one player. We declare that last
 *    remaining player the winner ("win by elimination") rather than
 *    letting them play alone.
 *  - In the LOBBY there is no timer; a disconnected lobby player is kept
 *    for LOBBY_GRACE_MS (so a phone refresh doesn't lose their seat),
 *    then silently dropped, freeing their color.
 *
 * Announcements are sent as i18n KEYS + params ({key:'announce.removed',
 * params:{name}}) — never formatted sentences — so EN/FA clients each
 * render in their own language (spec §4.1).
 *
 * The room knows nothing about sockets beyond `send(ws, obj)` /
 * broadcast helpers injected by server/index.js, which keeps this class
 * unit-testable (see test/game.test.js).
 */

const SL = require('../shared/protocol');
const { generateBoard } = require('./board');
const { rollDie, resolveRoll, animationBudgetMs } = require('./game');

const CFG = SL.CONFIG;
const LOBBY_GRACE_MS = 60_000;

const crypto = require('crypto');
const newId = () => crypto.randomBytes(6).toString('hex');
const newToken = () => crypto.randomBytes(16).toString('hex');

/** Room codes omit look-alikes (0/O, 1/I) so they can be typed from a TV. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRoomCode(existing) {
  let code;
  do {
    code = Array.from({ length: 5 },
      () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (existing.has(code));
  return code;
}

class Room {
  /**
   * @param {string} code
   * @param {{send:(ws:any,obj:any)=>void, rng?:Function}} io
   */
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.rng = io.rng || Math.random;
    this.phase = SL.Phase.LOBBY;
    this.turnPhase = null;
    this.lang = CFG.DEFAULT_LANG;     // room language (TV-controlled)
    this.hostWs = null;               // TV socket (not a player)
    this.players = new Map();         // playerId → player record
    this.order = [];                  // playerIds in turn order
    this.turnIndex = 0;
    this.board = null;                // generated at game start
    this.winnerId = null;
    this.turnTimer = null;            // 30s timeout handle
    this.animTimer = null;            // post-roll animation budget handle
    this.turnEndsAt = null;           // epoch ms, sent to clients
    this.lastActivityAt = Date.now(); // for idle-room cleanup in index.js
  }

  // ── messaging helpers ────────────────────────────────────────────────
  touch() { this.lastActivityAt = Date.now(); }
  send(ws, type, payload) { if (ws) this.io.send(ws, { type, ...payload }); }
  broadcast(type, payload) {
    this.send(this.hostWs, type, payload);
    for (const p of this.players.values()) this.send(p.ws, type, payload);
  }
  /** i18n-key announcement (spec §4.1) — clients localize. */
  announce(key, params) { this.broadcast(SL.S2C.ANNOUNCE, { key, params: params || {} }); }

  /** Public snapshot sent after every change; clients render ONLY this. */
  snapshot() {
    return {
      roomCode: this.code,
      phase: this.phase,
      turnPhase: this.turnPhase,
      lang: this.lang,
      board: this.board,
      turnPlayerId: this.currentPlayerId(),
      turnEndsAt: this.turnEndsAt,
      serverNow: Date.now(),
      winnerId: this.winnerId,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, colorId: p.colorId, avatar: p.avatar,
        position: p.position, misses: p.misses,
        connected: !!p.ws, removed: p.removed,
        // never expose p.token here
      })),
    };
  }
  broadcastState() { this.broadcast(SL.S2C.STATE, { state: this.snapshot() }); }

  // ── lobby ────────────────────────────────────────────────────────────
  attachHost(ws) { this.hostWs = ws; this.touch(); }

  addPlayer(ws, { name, colorId, avatar }) {
    if (this.phase !== SL.Phase.LOBBY) return { error: 'error.gameInProgress' };
    if (this.players.size >= CFG.MAX_PLAYERS) return { error: 'error.roomFull' };

    name = (name || '').trim().slice(0, CFG.NAME_MAX_LENGTH);
    if (!name) return { error: 'error.nameRequired' };

    // Colors are unique per room: honor the pick if free, else next free.
    const taken = new Set([...this.players.values()].map(p => p.colorId));
    let color = Number.isInteger(colorId) && CFG.COLORS[colorId] && !taken.has(colorId)
      ? colorId : CFG.COLORS.find(c => !taken.has(c.id)).id;

    const player = {
      id: newId(), token: newToken(), ws,
      name, colorId: color,
      avatar: CFG.AVATARS.includes(avatar) ? avatar : CFG.AVATARS[color],
      position: 0, misses: 0, removed: false, lobbyGraceTimer: null,
    };
    this.players.set(player.id, player);
    this.touch();
    this.announce('announce.playerJoined', { name });
    this.broadcastState();
    return { player };
  }

  /** Rebind a socket to an existing player (phone refresh / Wi-Fi blip). */
  reconnectPlayer(ws, playerId, token) {
    const p = this.players.get(playerId);
    // Removed players (3 misses) may not come back — spec: reconnection
    // works only "before removal".
    if (!p || p.removed || p.token !== token) return { error: 'error.reconnectFailed' };
    if (p.lobbyGraceTimer) { clearTimeout(p.lobbyGraceTimer); p.lobbyGraceTimer = null; }
    p.ws = ws;
    this.touch();
    this.announce('announce.playerReconnected', { name: p.name });
    this.broadcastState();
    // If it's their turn, re-send the deadline so the phone re-arms its UI.
    if (this.phase === SL.Phase.IN_PROGRESS && this.currentPlayerId() === p.id) {
      this.send(ws, SL.S2C.TURN, {
        turnPlayerId: p.id, turnEndsAt: this.turnEndsAt, serverNow: Date.now(),
      });
    }
    return { player: p };
  }

  handleDisconnect(ws) {
    if (ws === this.hostWs) {
      // TV closed/refreshed: room persists (phones keep state) until idle
      // cleanup; a new TV for this room is not expected mid-game [A5].
      this.hostWs = null;
      return;
    }
    for (const p of this.players.values()) {
      if (p.ws !== ws) continue;
      p.ws = null;
      this.announce('announce.playerDisconnected', { name: p.name });
      if (this.phase === SL.Phase.LOBBY) {
        // Seat is held briefly, then freed (incl. their color).
        p.lobbyGraceTimer = setTimeout(() => {
          if (!p.ws && this.phase === SL.Phase.LOBBY) {
            this.players.delete(p.id);
            this.broadcastState();
          }
        }, LOBBY_GRACE_MS);
      }
      // Mid-game: nothing else to do — the running turn timer converts a
      // dead phone into misses and eventually removal (see class docs).
      this.broadcastState();
      return;
    }
  }

  // ── game flow ────────────────────────────────────────────────────────
  setLanguage(lang) {
    if (!CFG.SUPPORTED_LANGS.includes(lang)) return;
    this.lang = lang;
    this.broadcast(SL.S2C.LANG, { lang });
    this.broadcastState();
  }

  startGame() {
    if (this.phase !== SL.Phase.LOBBY) return { error: 'error.gameInProgress' };
    const seated = [...this.players.values()].filter(p => !p.removed);
    if (seated.length < CFG.MIN_PLAYERS) return { error: 'error.needTwoPlayers' };

    this.board = generateBoard(this.rng);
    for (const p of seated) { p.position = 0; p.misses = 0; p.removed = false; }
    // Turn order: shuffled join order [spec allows random or join order].
    this.order = seated.map(p => p.id);
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
    this.turnIndex = 0;
    this.winnerId = null;
    this.phase = SL.Phase.IN_PROGRESS;
    this.announce('announce.gameStarted', {});
    this.broadcastState();
    this.beginTurn();
    return {};
  }

  currentPlayerId() {
    return this.phase === SL.Phase.IN_PROGRESS ? this.order[this.turnIndex] : null;
  }
  activePlayers() {
    return this.order.map(id => this.players.get(id)).filter(p => p && !p.removed);
  }

  /** Arm the 30s window for whoever is current. Single place timers set. */
  beginTurn() {
    this.clearTimers();
    this.turnPhase = SL.TurnPhase.AWAITING_ROLL;
    this.turnEndsAt = Date.now() + CFG.TURN_SECONDS * 1000;
    this.broadcast(SL.S2C.TURN, {
      turnPlayerId: this.currentPlayerId(),
      turnEndsAt: this.turnEndsAt, serverNow: Date.now(),
    });
    this.broadcastState();
    this.turnTimer = setTimeout(() => this.onTurnTimeout(), CFG.TURN_SECONDS * 1000);
  }

  onTurnTimeout() {
    if (this.phase !== SL.Phase.IN_PROGRESS ||
        this.turnPhase !== SL.TurnPhase.AWAITING_ROLL) return;
    const p = this.players.get(this.currentPlayerId());
    if (!p) return this.advanceTurn();
    p.misses += 1;
    this.announce('announce.turnMissed', { name: p.name, misses: p.misses, max: CFG.MAX_MISSES });
    if (p.misses >= CFG.MAX_MISSES) this.removePlayer(p);
    this.advanceTurnOrEnd();
  }

  removePlayer(p) {
    p.removed = true;
    p.token = null; // revoke reconnect
    if (p.ws) { this.send(p.ws, SL.S2C.ERROR, { key: 'error.youWereRemoved' }); }
    this.announce('announce.playerRemoved', { name: p.name });
  }

  /** Move rotation to the next non-removed player (possibly the same
   *  player on an extra roll) or end the game if <2 remain [A4]. */
  advanceTurnOrEnd(stayOnCurrent) {
    const alive = this.activePlayers();
    if (alive.length === 1) return this.endGame(alive[0].id, 'elimination');
    if (alive.length === 0) return this.endGame(null, 'elimination');

    if (!stayOnCurrent) {
      let guard = 0;
      do { this.turnIndex = (this.turnIndex + 1) % this.order.length; }
      while (this.players.get(this.order[this.turnIndex])?.removed && ++guard <= this.order.length);
    }
    this.beginTurn();
  }
  advanceTurn() { this.advanceTurnOrEnd(false); }

  /**
   * Handle a roll request. Authoritative checks: game running, correct
   * player, correct sub-phase (rejects double-taps / stale phones).
   */
  handleRoll(playerId) {
    if (this.phase !== SL.Phase.IN_PROGRESS) return { error: 'error.notInGame' };
    if (this.turnPhase !== SL.TurnPhase.AWAITING_ROLL) return { error: 'error.notYourTurn' };
    if (this.currentPlayerId() !== playerId) return { error: 'error.notYourTurn' };
    const p = this.players.get(playerId);
    if (!p || p.removed) return { error: 'error.notYourTurn' };

    this.clearTimers();
    this.turnPhase = SL.TurnPhase.ANIMATING;
    this.turnEndsAt = null;

    const roll = rollDie(this.rng);
    const plan = resolveRoll(this.board, p.position, roll);
    p.position = plan.finalPosition;
    this.touch();

    // The whole room animates from this one plan — dice result included,
    // so TV and phone reveals are synchronized, not independently random.
    this.broadcast(SL.S2C.DICE_ROLLED, { playerId: p.id, plan, serverNow: Date.now() });
    if (plan.entered) this.announce('announce.enteredBoard', { name: p.name });
    else if (p.position === 0 && !plan.overshot) this.announce('announce.needSix', { name: p.name });
    if (plan.overshot) this.announce('announce.overshoot', { name: p.name, roll });
    if (plan.feature?.type === 'snake') this.announce('announce.snake', { name: p.name });
    if (plan.feature?.type === 'ladder') this.announce('announce.ladder', { name: p.name });
    if (plan.extraRoll && !plan.isWin) this.announce('announce.rolledSix', { name: p.name });
    this.broadcastState();

    // Advance only after every client had time to play the timeline.
    this.animTimer = setTimeout(() => {
      if (this.phase !== SL.Phase.IN_PROGRESS) return;
      if (plan.isWin) return this.endGame(p.id, 'exact100');
      this.advanceTurnOrEnd(plan.extraRoll); // 6 → same player, fresh 30s [A2]
    }, animationBudgetMs(plan, CFG));
    return {};
  }

  endGame(winnerId, reason) {
    this.clearTimers();
    this.phase = SL.Phase.GAME_OVER;
    this.turnPhase = null;
    this.turnEndsAt = null;
    this.winnerId = winnerId;
    const w = winnerId ? this.players.get(winnerId) : null;
    if (w) this.announce('announce.winner', { name: w.name });
    this.broadcast(SL.S2C.GAME_OVER, { winnerId, reason });
    this.broadcastState();
  }

  /** GAME_OVER → LOBBY with same seats (new board on next start). */
  rematch() {
    if (this.phase !== SL.Phase.GAME_OVER) return { error: 'error.notInGame' };
    this.clearTimers();
    this.phase = SL.Phase.LOBBY;
    this.board = null;
    this.order = [];
    this.winnerId = null;
    // Removed players keep their seat out of the next game unless they
    // rejoin fresh; drop them, reset everyone else.
    for (const [id, p] of this.players) {
      if (p.removed || !p.ws) this.players.delete(id);
      else { p.position = 0; p.misses = 0; }
    }
    this.broadcastState();
    return {};
  }

  clearTimers() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.animTimer) clearTimeout(this.animTimer);
    this.turnTimer = this.animTimer = null;
  }
  destroy() {
    this.clearTimers();
    for (const p of this.players.values()) {
      if (p.lobbyGraceTimer) clearTimeout(p.lobbyGraceTimer);
    }
  }
}

module.exports = { Room, newRoomCode };
