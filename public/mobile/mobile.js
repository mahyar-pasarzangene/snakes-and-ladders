/**
 * public/mobile/mobile.js — phone controller client.
 *
 * Flow: /join/<CODE> (from the TV QR) → join form (name/color/avatar) →
 * controller: huge ROLL button on your turn, synchronized dice animation
 * (same plan as the TV — spec §4), your position, turn timer, standings.
 *
 * Reconnection: playerId + secret token are kept in localStorage per
 * room; on socket (re)open we send player:reconnect and the server
 * restores seat/turn if the player hasn't been removed (spec §3).
 *
 * Language (spec §4.1 assumption A6): the phone FOLLOWS the room
 * language set on the TV, unless the player taps the phone's own
 * EN/فارسی toggle — that creates a sticky per-phone override.
 */
(function () {
  'use strict';
  var CFG = SL.CONFIG;
  var $ = function (id) { return document.getElementById(id); };

  // Room code from /join/<CODE>; manual entry field when opened at /m/.
  var pathMatch = location.pathname.match(/\/join\/([A-Za-z0-9]+)/);
  var roomCode = pathMatch ? pathMatch[1].toUpperCase() : '';

  var sock = new GameSocket();
  var dice = new Dice($('diceEl'));
  var me = { id: null, token: null };
  var state = null;
  var clockOffset = 0;
  var pickedColor = 0;
  var pickedAvatar = CFG.AVATARS[0];
  var rolling = false;
  var langOverride = null;
  try { langOverride = localStorage.getItem('sl-lang-override'); } catch (e) {}

  // ── session persistence ────────────────────────────────────────────
  function sessionKey() { return 'sl-session-' + roomCode; }
  function saveSession() {
    try { localStorage.setItem(sessionKey(), JSON.stringify(me)); } catch (e) {}
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(sessionKey()) || 'null'); }
    catch (e) { return null; }
  }
  function clearSession() { try { localStorage.removeItem(sessionKey()); } catch (e) {} }

  // ── join form ──────────────────────────────────────────────────────
  (function buildPickers() {
    var cw = $('colorSwatches');
    CFG.COLORS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch color' + (c.id === pickedColor ? ' sel' : '');
      b.style.setProperty('--c', c.hex);
      b.setAttribute('aria-label', I18n.t('color.' + c.id));
      b.addEventListener('click', function () {
        pickedColor = c.id;
        Sound.unlock();
        Array.prototype.forEach.call(cw.children, function (x, i) { x.classList.toggle('sel', i === c.id); });
      });
      cw.appendChild(b);
    });
    var aw = $('avatarSwatches');
    CFG.AVATARS.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (a === pickedAvatar ? ' sel' : '');
      b.textContent = a;
      b.addEventListener('click', function () {
        pickedAvatar = a;
        Sound.unlock();
        Array.prototype.forEach.call(aw.children, function (x) { x.classList.toggle('sel', x.textContent === a); });
      });
      aw.appendChild(b);
    });
  })();

  function refreshRoomLine() {
    $('roomLine').textContent = roomCode
      ? I18n.t('join.room', { code: roomCode })
      : '';
    $('codeField').hidden = !!roomCode;
  }
  refreshRoomLine();

  try {
    var savedName = localStorage.getItem('sl-name');
    if (savedName) $('nameInput').value = savedName;
  } catch (e) {}

  $('joinBtn').addEventListener('click', function () {
    Sound.unlock();
    var name = $('nameInput').value.trim().slice(0, CFG.NAME_MAX_LENGTH);
    if (!roomCode) {
      roomCode = $('codeInput').value.trim().toUpperCase();
      if (roomCode) history.replaceState(null, '', '/join/' + roomCode);
    }
    if (!name) { showError(I18n.t('error.nameRequired')); return; }
    try { localStorage.setItem('sl-name', name); } catch (e) {}
    $('joinBtn').disabled = true;
    $('joinBtn').textContent = I18n.t('join.joining');
    clearSession();
    sock.send(SL.C2S.PLAYER_JOIN, {
      roomCode: roomCode, name: name, colorId: pickedColor, avatar: pickedAvatar,
    });
  });

  function showError(text) {
    $('joinError').textContent = text;
    $('joinBtn').disabled = false;
    I18n.apply($('joinView'));
  }

  // ── views / rendering ──────────────────────────────────────────────
  function show(view) {
    $('joinView').hidden = view !== 'join';
    $('gameView').hidden = view !== 'game';
    $('endView').hidden = view !== 'end';
  }

  function myRecord() {
    if (!state || !me.id) return null;
    var found = null;
    state.players.forEach(function (p) { if (p.id === me.id) found = p; });
    return found;
  }
  function playerById(id) {
    var found = null;
    if (state) state.players.forEach(function (p) { if (p.id === id) found = p; });
    return found;
  }

  function render() {
    if (!state || !me.id) return;
    var mine = myRecord();
    if (!mine) return;

    // Follow room language unless overridden on this phone [A6].
    if (!langOverride && state.lang && state.lang !== I18n.lang) {
      I18n.setLang(state.lang, { skipPersist: true }).then(render);
      return;
    }

    if (mine.removed) {
      show('end');
      $('endEmoji').textContent = '⌛';
      $('endTitle').textContent = I18n.t('tv.removedTag');
      $('endLine').textContent = I18n.t('play.removedInfo', { max: CFG.MAX_MISSES });
      return;
    }
    if (state.phase === 'GAME_OVER') {
      show('end');
      var w = playerById(state.winnerId);
      $('endEmoji').textContent = (w && w.avatar) || '🏆';
      $('endTitle').textContent = state.winnerId === me.id
        ? I18n.t('play.youWon')
        : I18n.t('play.gameOver', { name: w ? w.name : '' });
      $('endLine').textContent = I18n.t('play.watchTv');
      return;
    }

    show('game');
    $('meChip').style.setProperty('--pc', CFG.COLORS[mine.colorId].hex);
    $('meAvatar').textContent = mine.avatar;
    $('meName').textContent = mine.name;
    $('mePos').textContent = mine.position > 0
      ? I18n.t('tv.position', { n: mine.position })
      : I18n.t('tv.offBoard');

    var isMyTurn = state.phase === 'IN_PROGRESS' &&
      state.turnPlayerId === me.id && state.turnPhase === 'AWAITING_ROLL';
    var rollBtn = $('rollBtn');
    rollBtn.disabled = !isMyTurn || rolling;
    rollBtn.classList.toggle('pulse', isMyTurn && !rolling);
    $('timerBar').hidden = state.phase !== 'IN_PROGRESS';

    if (state.phase === 'LOBBY') {
      $('statusLine').textContent = I18n.t('play.waitingStart');
    } else if (isMyTurn) {
      $('statusLine').textContent = mine.position === 0
        ? I18n.t('play.offBoardHint')
        : I18n.t('play.yourTurn');
    } else if (state.phase === 'IN_PROGRESS') {
      var cur = playerById(state.turnPlayerId);
      $('statusLine').textContent = cur ? I18n.t('play.turnOf', { name: cur.name }) : '';
    }

    // Standings: furthest first, progress bar per player.
    $('standingsTitle').textContent =
      I18n.t('tv.playersJoined', { count: state.players.length, max: CFG.MAX_PLAYERS });
    var ul = $('standings');
    ul.innerHTML = '';
    state.players.slice()
      .sort(function (a, b) { return b.position - a.position; })
      .forEach(function (p) {
        var li = document.createElement('li');
        li.className = (state.turnPlayerId === p.id ? 'active ' : '') + (!p.connected || p.removed ? 'offline' : '');
        li.style.setProperty('--pc', CFG.COLORS[p.colorId].hex);
        var av = document.createElement('span'); av.className = 's-av'; av.textContent = p.avatar;
        var nm = document.createElement('span'); nm.className = 's-name';
        nm.setAttribute('dir', 'auto'); nm.textContent = p.name;
        var bar = document.createElement('span'); bar.className = 's-bar';
        var fill = document.createElement('span'); fill.className = 's-fill';
        fill.style.display = 'block';
        fill.style.transform = 'scaleX(' + (p.position / 100) + ')';
        bar.appendChild(fill);
        var pos = document.createElement('span'); pos.className = 's-pos';
        pos.textContent = p.position > 0 ? I18n.fmt(p.position) : '—';
        li.appendChild(av); li.appendChild(nm); li.appendChild(bar); li.appendChild(pos);
        ul.appendChild(li);
      });
  }

  // Turn countdown (shared deadline from the server).
  (function tick() {
    requestAnimationFrame(tick);
    if (!state || !state.turnEndsAt || state.phase !== 'IN_PROGRESS') return;
    var remain = Math.max(0, state.turnEndsAt - (Date.now() + clockOffset));
    var frac = remain / (CFG.TURN_SECONDS * 1000);
    var fill = $('timerFill');
    fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, frac)) + ')';
    fill.classList.toggle('urgent', remain < 5000);
  })();

  function toast(key, params) {
    var box = $('toasts');
    while (box.children.length >= 2) box.removeChild(box.firstChild);
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = I18n.t(key, params);
    box.appendChild(t);
    if (window.gsap) {
      gsap.fromTo(t, { y: 20, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.3 });
      gsap.to(t, { autoAlpha: 0, delay: 3.2, duration: 0.4, onComplete: function () { t.remove(); } });
    } else setTimeout(function () { t.remove(); }, 3600);
  }

  $('rollBtn').addEventListener('click', function () {
    Sound.unlock();
    rolling = true;
    $('rollBtn').disabled = true;
    $('rollBtn').classList.remove('pulse');
    sock.send(SL.C2S.PLAYER_ROLL, {});
    tryWakeLock();
  });

  // Keep the phone awake during the party where the browser allows it.
  function tryWakeLock() {
    try {
      if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(function () {});
    } catch (e) {}
  }

  // ── language / sound controls ──────────────────────────────────────
  function refreshLangSeg() {
    Array.prototype.forEach.call($('langSeg').children, function (b) {
      b.classList.toggle('active', b.getAttribute('data-lang') === I18n.lang);
    });
  }
  $('langSeg').addEventListener('click', function (e) {
    var lang = e.target.getAttribute && e.target.getAttribute('data-lang');
    if (!lang) return;
    langOverride = lang; // sticky per-phone override from now on [A6]
    try { localStorage.setItem('sl-lang-override', lang); } catch (err) {}
    I18n.setLang(lang).then(function () { refreshLangSeg(); refreshRoomLine(); render(); });
  });
  function refreshSound() { $('soundBtn').textContent = Sound.isMuted() ? '🔇' : '🔊'; }
  $('soundBtn').addEventListener('click', function () {
    Sound.setMuted(!Sound.isMuted()); refreshSound();
  });

  // ── socket wiring ──────────────────────────────────────────────────
  function tryReconnect() {
    var s = loadSession();
    if (roomCode && s && s.id && s.token) {
      sock.send(SL.C2S.PLAYER_RECONNECT, { roomCode: roomCode, playerId: s.id, token: s.token });
      return true;
    }
    return false;
  }
  sock.onOpen = function () { tryReconnect(); };
  sock.onReopen(function () { tryReconnect(); });

  sock.on(SL.S2C.PLAYER_JOINED, function (msg) {
    me = { id: msg.playerId, token: msg.token };
    saveSession();
    state = msg.state;
    show('game');
    render();
    tryWakeLock();
  });
  sock.on(SL.S2C.STATE, function (msg) {
    state = msg.state;
    // lobby → game-over cleanup: after a rematch, removed/dropped
    // players vanish from the roster — send them back to the join form.
    if (me.id && !myRecord()) {
      clearSession(); me = { id: null, token: null };
      show('join'); $('joinBtn').disabled = false; I18n.apply(document);
      return;
    }
    render();
  });
  sock.on(SL.S2C.TURN, function (msg) {
    clockOffset = msg.serverNow - Date.now();
    if (state) { state.turnPlayerId = msg.turnPlayerId; state.turnEndsAt = msg.turnEndsAt; }
    rolling = false;
    if (msg.turnPlayerId === me.id) {
      Sound.turn();
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    }
    render();
  });
  sock.on(SL.S2C.DICE_ROLLED, function (msg) {
    clockOffset = msg.serverNow - Date.now();
    rolling = false;
    dice.rollTo(msg.plan.roll, CFG.DICE_ANIM_MS);
    Sound.dice();
    var p = playerById(msg.playerId);
    $('statusLine').textContent = msg.playerId === me.id
      ? I18n.t('play.youRolled', { roll: msg.plan.roll })
      : I18n.t('play.rolledInfo', { name: p ? p.name : '', roll: msg.plan.roll });
  });
  sock.on(SL.S2C.LANG, function (msg) {
    if (!langOverride) I18n.setLang(msg.lang, { skipPersist: true }).then(function () {
      refreshLangSeg(); refreshRoomLine(); render();
    });
  });
  sock.on(SL.S2C.ANNOUNCE, function (msg) {
    toast(msg.key, msg.params);
    if (msg.key === 'announce.winner') Sound.win();
  });
  sock.on(SL.S2C.ERROR, function (msg) {
    if (msg.key === 'error.reconnectFailed') { clearSession(); show('join'); return; }
    if (msg.key === 'error.roomNotFound' && !me.id) { showError(I18n.t('join.wrongRoom')); return; }
    if (!me.id) showError(I18n.t(msg.key, msg.params));
    else toast(msg.key, msg.params);
  });
  sock.onStatus(function (connected) {
    $('connDot').className = 'conn' + (connected ? ' on' : '');
    $('connDot').title = I18n.t(connected ? 'play.connected' : 'play.reconnecting');
    if (!connected && me.id) toast('play.reconnecting', {});
  });

  I18n.onChange(function () { refreshLangSeg(); refreshRoomLine(); render(); });

  // ── boot ───────────────────────────────────────────────────────────
  I18n.setLang(langOverride || I18n.detect()).then(function () {
    refreshLangSeg(); refreshSound(); refreshRoomLine();
  });
  sock.connect();
})();
