/**
 * shared/protocol.js — single source of truth for the wire protocol and
 * game constants. Required by the Node server AND served verbatim to both
 * browser clients (attached to window.SL there). Keep this file free of
 * Node- or DOM-specific APIs so it runs unchanged in both environments.
 */
(function (global) {
  'use strict';

  var SL = {
    /** Game rules / tuning (spec §3). Server is authoritative for all of it. */
    CONFIG: {
      BOARD_SIZE: 100,
      COLS: 10,
      MIN_PLAYERS: 2,
      MAX_PLAYERS: 8,
      TURN_SECONDS: 30,
      MAX_MISSES: 3,
      NAME_MAX_LENGTH: 16,
      // Animation budget the server waits before advancing the turn, so every
      // client can finish the same timeline (spec §2.2 "timeline per move").
      DICE_ANIM_MS: 1000,
      STEP_MS: 260,          // per-square hop on the TV timeline
      SLIDE_MS: 800,         // snake / ladder follow-up
      /** Player token palette (index = colorId). 8 players max. */
      COLORS: [
        { id: 0, hex: '#ef4444' }, // red
        { id: 1, hex: '#3b82f6' }, // blue
        { id: 2, hex: '#22c55e' }, // green
        { id: 3, hex: '#eab308' }, // yellow
        { id: 4, hex: '#a855f7' }, // purple
        { id: 5, hex: '#ec4899' }, // pink
        { id: 6, hex: '#14b8a6' }, // teal
        { id: 7, hex: '#f97316' }, // orange
      ],
      AVATARS: ['🦁', '🦊', '🐼', '🦉', '🐸', '🦄', '🐙', '🦋'],
      SUPPORTED_LANGS: ['en', 'fa'],
      DEFAULT_LANG: 'en',
    },

    /** Room-level state machine states (spec §2). */
    Phase: { LOBBY: 'LOBBY', IN_PROGRESS: 'IN_PROGRESS', GAME_OVER: 'GAME_OVER' },
    /** Sub-phases while IN_PROGRESS. */
    TurnPhase: { AWAITING_ROLL: 'AWAITING_ROLL', ANIMATING: 'ANIMATING' },

    /** Client → Server message types. */
    C2S: {
      HOST_CREATE: 'host:create',     // TV: create a room, become its host
      HOST_START: 'host:start',       // TV: start the game (lobby only)
      HOST_REMATCH: 'host:rematch',   // TV: back to lobby for a new game
      HOST_SET_LANG: 'host:setLang',  // TV: set room language (spec §4.1)
      PLAYER_JOIN: 'player:join',     // phone: {roomCode, name, colorId, avatar}
      PLAYER_RECONNECT: 'player:reconnect', // phone: {roomCode, playerId, token}
      PLAYER_ROLL: 'player:roll',     // phone: roll the die (validated server-side)
      PING: 'ping',
    },

    /** Server → Client message types. */
    S2C: {
      ROOM_CREATED: 'room:created',   // → TV: {roomCode, joinUrl, qrSvg, state}
      STATE: 'room:state',            // → all: full room snapshot (players, board…)
      PLAYER_JOINED: 'player:joined', // → phone: {playerId, token, state}
      DICE_ROLLED: 'dice:rolled',     // → all: full move plan (see server/game.js)
      TURN: 'turn:changed',           // → all: {turnPlayerId, endsAt, serverNow}
      ANNOUNCE: 'announce',           // → all: {key, params} — i18n key, NOT text (§4.1)
      LANG: 'room:lang',              // → all: {lang} room language changed
      GAME_OVER: 'game:over',         // → all: {winnerId, reason}
      ERROR: 'error',                 // → one: {key, params} i18n error key
      PONG: 'pong',
    },

    /**
     * Boustrophedon (zig-zag) board geometry — shared so server tests and
     * both clients agree. Square 1 = bottom-left, 10 = bottom-right,
     * 11 = one row up at the RIGHT, 20 = left … 100 = top-left.
     * Returns {col: 0-9 left→right, row: 0-9 bottom→top}.
     * NOTE: the board is NEVER mirrored in RTL mode (spec §3/§4.1), so this
     * mapping is identical for English and Persian.
     */
    squareToXY: function (n) {
      var row = Math.floor((n - 1) / 10);
      var idx = (n - 1) % 10;
      var col = row % 2 === 0 ? idx : 9 - idx;
      return { col: col, row: row };
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SL;
  global.SL = SL;
})(typeof window !== 'undefined' ? window : globalThis);
