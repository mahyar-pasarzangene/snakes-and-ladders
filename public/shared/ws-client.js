/**
 * public/shared/ws-client.js — resilient WebSocket wrapper shared by TV
 * and mobile clients: JSON framing, heartbeat ping, and automatic
 * reconnect with capped exponential backoff. On reconnect it fires
 * `onReopen` so the client can re-identify (host: no-op — the room is
 * gone if the TV socket died; phone: player:reconnect with its token,
 * see mobile.js). URL comes from /config.js (window.APP_CONFIG.wsUrl)
 * or falls back to the page's own origin (Modes A/C — spec §2.1).
 */
(function () {
  'use strict';

  function wsUrl() {
    if (window.APP_CONFIG && window.APP_CONFIG.wsUrl) return window.APP_CONFIG.wsUrl;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host;
  }

  function GameSocket() {
    this.handlers = {};
    this.statusHandlers = [];
    this.reopenHandlers = [];
    this.ws = null;
    this.backoff = 500;
    this.everOpened = false;
    this.closedByUser = false;
    this.pingTimer = null;
  }

  GameSocket.prototype.on = function (type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
  };
  GameSocket.prototype.onStatus = function (fn) { this.statusHandlers.push(fn); };
  GameSocket.prototype.onReopen = function (fn) { this.reopenHandlers.push(fn); };
  GameSocket.prototype._status = function (connected) {
    for (var i = 0; i < this.statusHandlers.length; i++) this.statusHandlers[i](connected);
  };

  GameSocket.prototype.connect = function () {
    var self = this;
    var ws;
    try { ws = new WebSocket(wsUrl()); } catch (e) { this._scheduleRetry(); return; }
    this.ws = ws;

    ws.onopen = function () {
      self.backoff = 500;
      self._status(true);
      // Heartbeat both detects half-open links and counts as traffic,
      // which keeps free-tier hosts (Render) awake during a live game.
      clearInterval(self.pingTimer);
      self.pingTimer = setInterval(function () { self.send(window.SL ? SL.C2S.PING : 'ping', {}); }, 20000);
      if (self.everOpened) {
        for (var i = 0; i < self.reopenHandlers.length; i++) self.reopenHandlers[i]();
      }
      self.everOpened = true;
      if (self.onOpen) self.onOpen();
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      var list = self.handlers[msg.type] || [];
      for (var i = 0; i < list.length; i++) {
        try { list[i](msg); } catch (err) { if (window.console) console.error(err); }
      }
    };
    ws.onclose = function () {
      clearInterval(self.pingTimer);
      self._status(false);
      if (!self.closedByUser) self._scheduleRetry();
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  };

  GameSocket.prototype._scheduleRetry = function () {
    var self = this;
    var wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 5000);
    setTimeout(function () { if (!self.closedByUser) self.connect(); }, wait);
  };

  GameSocket.prototype.send = function (type, payload) {
    if (this.ws && this.ws.readyState === 1) {
      var obj = { type: type };
      if (payload) for (var k in payload) obj[k] = payload[k];
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  };

  window.GameSocket = GameSocket;
})();
