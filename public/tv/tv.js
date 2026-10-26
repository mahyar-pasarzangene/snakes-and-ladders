/**
 * public/tv/tv.js — TV display client.
 *
 * Renders ONLY server-pushed state (spec §2): `room:state` snapshots,
 * `dice:rolled` move plans, `turn:changed` deadlines, `announce` i18n
 * keys. All motion is GSAP transform/opacity tweens built as ONE
 * timeline per move (spec §2.2); timelines/tweens are killed on teardown.
 * A frame-rate probe auto-enables low-effects mode on weak TV hardware.
 *
 * The board is rendered in a dir="ltr" island and NEVER mirrored in
 * Persian/RTL mode (spec §3/§4.1) — only its numbers are re-localized.
 */
(function () {
  'use strict';
  var CFG = SL.CONFIG;
  var $ = function (id) { return document.getElementById(id); };

  // ── state ──────────────────────────────────────────────────────────
  var sock = new GameSocket();
  var state = null;            // latest server snapshot
  var roomCreated = false;
  var dice = new Dice($('diceEl'));
  var tokenEls = {};           // playerId → token element
  var animatingId = null;      // player currently on a GSAP timeline
  var pendingSnap = false;     // a state arrived mid-animation
  var clockOffset = 0;         // serverNow − Date.now()
  var lowFx = false;
  try { lowFx = localStorage.getItem('sl-lowfx') === '1'; } catch (e) {}

  var STEP = function () { return lowFx ? 150 : CFG.STEP_MS; };
  var SLIDE = function () { return lowFx ? 450 : CFG.SLIDE_MS; };

  // ── board geometry ─────────────────────────────────────────────────
  // Board is 1000×1000 in SVG units; square n center:
  function center(n) {
    var xy = SL.squareToXY(n);
    return { x: xy.col * 100 + 50, y: 950 - xy.row * 100 };
  }
  // Token position as % translate. Square 0 = "pen" below square 1 area,
  // spread by off-board index so waiting players are visible at the start.
  function tokenPos(player, all) {
    if (player.position === 0) {
      var offs = all.filter(function (p) { return p.position === 0 && !p.removed; });
      var i = offs.indexOf(player);
      return { x: 5 + i * 6, y: 96.5 };
    }
    var c = center(player.position);
    var same = all.filter(function (p) { return p.position === player.position && !p.removed; });
    var idx = same.indexOf(player), k = same.length;
    var dx = 0, dy = 0;
    if (k > 1) { // mini-grid offsets so stacked tokens stay readable
      dx = (idx % 2 === 0 ? -1 : 1) * 1.7;
      dy = (idx < 2 ? -1 : 1) * 1.7;
    }
    return { x: c.x / 10 + dx, y: c.y / 10 + dy };
  }
  function moveTokenEl(el, pos, animateOpts) {
    var x = 'translate(' + pos.x + '00%,' + pos.y + '00%)'; // % of board via 10% cells
    // Tokens are absolutely positioned squares sized in %; translate in
    // board-% needs board-relative units → use vw-independent approach:
    // we set transform with percentage of the TOKEN's own size instead,
    // which equals board% × (100 / 7.2)… simpler: use left/top-free
    // CSS transform with `cqw`? Not on old TVs. We store pixel-free by
    // translating with % of board through a wrapper: token width is
    // 7.2% of board, so board% = token% × 7.2/100 → factor 13.888.
    var f = 100 / 7.2;
    if (animateOpts && window.gsap) {
      return gsap.to(el, {
        xPercent: 0, // ensure clean basis
        x: 0, y: 0,
        duration: 0,
        onComplete: function () {},
      });
    }
    el.style.transform = 'translate(' + (pos.x * f) + '%,' + (pos.y * f) + '%)';
    return null;
  }
  // NOTE: the helper above is intentionally NOT used for animation —
  // GSAP animates `x`/`y` in px, which requires measuring the board.
  // posToPx() below is the single source used by both paths.
  function posToPx(pos) {
    var b = $('board').getBoundingClientRect();
    return { x: pos.x / 100 * b.width, y: pos.y / 100 * b.height };
  }
  function placeToken(el, pos) {
    var px = posToPx(pos);
    if (window.gsap) gsap.set(el, { x: px.x, y: px.y });
    else el.style.transform = 'translate(' + px.x + 'px,' + px.y + 'px)';
  }

  // ── static board cells (built once; numbers re-localized on lang) ──
  var cellNums = [];
  (function buildCells() {
    var cells = $('cells');
    for (var r = 9; r >= 0; r--) {
      for (var c = 0; c < 10; c++) {
        // invert squareToXY: for visual (col,row) find the square number
        var idx = r % 2 === 0 ? c : 9 - c;
        var n = r * 10 + idx + 1;
        var d = document.createElement('div');
        d.className = 'cell ' + (((r + c) % 2 === 0) ? 'a' : 'b') + (n === 100 ? ' goal' : '');
        var num = document.createElement('span');
        num.className = 'num';
        num.setAttribute('data-n', n);
        d.appendChild(num);
        cells.appendChild(d);
        cellNums.push(num);
      }
    }
  })();
  function localizeBoardNumbers() {
    cellNums.forEach(function (el) { el.textContent = I18n.fmt(el.getAttribute('data-n')); });
  }

  // ── snakes & ladders artwork (SVG) ─────────────────────────────────
  // Small deterministic PRNG so a snake's wiggle is stable across re-renders.
  function seeded(seed) {
    var s = seed * 2654435761 % 4294967296;
    return function () { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  }
  var SNAKE_HUES = [130, 95, 160, 45, 280, 200, 15, 340, 75, 320];

  function snakePath(head, tail) {
    var a = center(head), b = center(tail), rnd = seeded(head * 100 + tail);
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len;           // perpendicular
    var segs = Math.max(3, Math.round(len / 140));
    var pts = [a];
    for (var i = 1; i < segs; i++) {
      var t = i / segs;
      var amp = Math.sin(t * Math.PI) * (46 + rnd() * 30) * (i % 2 ? 1 : -1);
      pts.push({ x: a.x + dx * t + nx * amp, y: a.y + dy * t + ny * amp });
    }
    pts.push(b);
    // Smooth polyline → cubic curves through midpoints.
    var d = 'M ' + pts[0].x + ' ' + pts[0].y;
    for (var j = 1; j < pts.length - 1; j++) {
      var mx = (pts[j].x + pts[j + 1].x) / 2, my = (pts[j].y + pts[j + 1].y) / 2;
      d += ' Q ' + pts[j].x + ' ' + pts[j].y + ' ' + mx + ' ' + my;
    }
    var last = pts[pts.length - 1];
    d += ' L ' + last.x + ' ' + last.y;
    return { d: d, head: a, tail: b };
  }

  var lastBoardJson = null;
  function drawBoard(board) {
    // Snapshots arrive several times per roll; only rebuild the SVG when
    // the layout actually changed (new game) — kind to weak TV CPUs.
    var key = board ? JSON.stringify(board) : null;
    if (key === lastBoardJson) return;
    lastBoardJson = key;
    var svg = $('features');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!board) return;
    var NS = 'http://www.w3.org/2000/svg';
    function el(tag, attrs) {
      var e = document.createElementNS(NS, tag);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      svg.appendChild(e);
      return e;
    }
    // Ladders first (snakes slither over them visually).
    Object.keys(board.ladders).forEach(function (from) {
      var a = center(+from), b = center(board.ladders[from]);
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / len * 17, ny = dx / len * 17;
      var rail = { stroke: '#b5772e', 'stroke-width': 11, 'stroke-linecap': 'round' };
      el('line', Object.assign({ x1: a.x + nx, y1: a.y + ny, x2: b.x + nx, y2: b.y + ny }, rail));
      el('line', Object.assign({ x1: a.x - nx, y1: a.y - ny, x2: b.x - nx, y2: b.y - ny }, rail));
      var rungs = Math.max(2, Math.round(len / 52));
      for (var i = 1; i < rungs; i++) {
        var t = i / rungs;
        el('line', {
          x1: a.x + dx * t + nx, y1: a.y + dy * t + ny,
          x2: a.x + dx * t - nx, y2: a.y + dy * t - ny,
          stroke: '#d99a4e', 'stroke-width': 9, 'stroke-linecap': 'round',
        });
      }
    });
    Object.keys(board.snakes).forEach(function (head, i) {
      var p = snakePath(+head, board.snakes[head]);
      var hue = SNAKE_HUES[i % SNAKE_HUES.length];
      el('path', { d: p.d, fill: 'none', stroke: 'hsl(' + hue + ',55%,38%)', 'stroke-width': 21, 'stroke-linecap': 'round' });
      el('path', { d: p.d, fill: 'none', stroke: 'hsl(' + hue + ',65%,52%)', 'stroke-width': 15, 'stroke-linecap': 'round' });
      // belly dashes
      el('path', { d: p.d, fill: 'none', stroke: 'hsl(' + hue + ',70%,68%)', 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-dasharray': '3 16' });
      // head: ellipse oriented along the first segment + eyes + tongue
      var rnd = seeded(+head);
      var hx = p.head.x, hy = p.head.y;
      var g = el('g', { transform: 'translate(' + hx + ',' + hy + ') rotate(' + (rnd() * 50 - 25) + ')' });
      function gel(tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); g.appendChild(e); }
      gel('ellipse', { rx: 21, ry: 16, fill: 'hsl(' + hue + ',60%,45%)' });
      gel('circle', { cx: -7, cy: -6, r: 4.6, fill: '#fff' });
      gel('circle', { cx: 7, cy: -6, r: 4.6, fill: '#fff' });
      gel('circle', { cx: -7, cy: -6, r: 2.2, fill: '#191026' });
      gel('circle', { cx: 7, cy: -6, r: 2.2, fill: '#191026' });
      gel('path', { d: 'M0 12 L0 24 M0 24 L-6 32 M0 24 L6 32', stroke: '#e11d48', 'stroke-width': 3.4, fill: 'none', 'stroke-linecap': 'round' });
    });
  }

  // ── players panel + tokens ─────────────────────────────────────────
  function colorOf(p) { return CFG.COLORS[p.colorId].hex; }

  function renderPlayers() {
    var ul = $('players');
    ul.innerHTML = '';
    var players = state.players;
    $('playersTitle').textContent = players.length === 0
      ? I18n.t('tv.waitingPlayers')
      : I18n.t('tv.playersJoined', { count: players.length, max: CFG.MAX_PLAYERS });

    players.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'player' +
        (state.turnPlayerId === p.id ? ' active' : '') +
        (!p.connected ? ' offline' : '') +
        (p.removed ? ' removed' : '');
      li.style.setProperty('--pc', colorOf(p));

      var av = document.createElement('span');
      av.className = 'p-avatar'; av.textContent = p.avatar;
      var main = document.createElement('span'); main.className = 'p-main';
      var nm = document.createElement('span'); nm.className = 'p-name';
      nm.setAttribute('dir', 'auto'); nm.textContent = p.name;
      var meta = document.createElement('span'); meta.className = 'p-meta';
      var bits = [];
      bits.push(p.position > 0 ? I18n.t('tv.position', { n: p.position }) : I18n.t('tv.offBoard'));
      if (state.phase === 'IN_PROGRESS') bits.push(I18n.t('tv.misses', { n: p.misses, max: CFG.MAX_MISSES }));
      if (p.removed) bits.push(I18n.t('tv.removedTag'));
      else if (!p.connected) bits.push(I18n.t('tv.disconnected'));
      meta.textContent = bits.join(' · ');
      main.appendChild(nm); main.appendChild(meta);
      var pos = document.createElement('span'); pos.className = 'p-pos';
      pos.textContent = p.position > 0 ? I18n.fmt(p.position) : '—';
      li.appendChild(av); li.appendChild(main); li.appendChild(pos);
      ul.appendChild(li);
    });

    var lobbyHint = $('lobbyHint');
    if (state.phase === 'LOBBY' && roomCreated) {
      $('startBtn').disabled = players.length < CFG.MIN_PLAYERS;
      lobbyHint.textContent = players.length < CFG.MIN_PLAYERS
        ? I18n.t('tv.needMore', { min: CFG.MIN_PLAYERS })
        : I18n.t('tv.startHint');
    }
  }

  function ensureTokens() {
    var layer = $('tokens');
    var seen = {};
    state.players.forEach(function (p) {
      seen[p.id] = true;
      var el = tokenEls[p.id];
      if (!el) {
        el = document.createElement('div');
        el.className = 'token';
        tokenEls[p.id] = el;
        layer.appendChild(el);
        placeToken(el, tokenPos(p, state.players));
      }
      el.textContent = p.avatar;
      el.style.setProperty('--pc', colorOf(p));
      el.classList.toggle('active', state.turnPlayerId === p.id && state.phase === 'IN_PROGRESS');
      el.classList.toggle('offline', !p.connected);
      el.classList.toggle('removed', !!p.removed);
    });
    Object.keys(tokenEls).forEach(function (id) {
      if (!seen[id]) {
        if (window.gsap) gsap.killTweensOf(tokenEls[id]);
        tokenEls[id].remove();
        delete tokenEls[id];
      }
    });
  }

  function snapTokens(exceptId) {
    state.players.forEach(function (p) {
      if (p.id === exceptId) return;
      var el = tokenEls[p.id];
      if (el) placeToken(el, tokenPos(p, state.players));
    });
  }

  // ── toasts (localized announcements) ───────────────────────────────
  function toast(key, params) {
    var box = $('toasts');
    while (box.children.length >= 3) box.removeChild(box.firstChild);
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = I18n.t(key, params);
    box.appendChild(t);
    if (window.gsap) {
      gsap.fromTo(t, { y: 24, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.35, ease: 'power2.out' });
      gsap.to(t, { autoAlpha: 0, y: -12, delay: 3.6, duration: 0.4, onComplete: function () { t.remove(); } });
    } else {
      setTimeout(function () { t.remove(); }, 4000);
    }
  }

  // ── move animation: one GSAP timeline per roll (spec §2.2) ─────────
  function animatePlan(playerId, plan) {
    var player = null;
    state.players.forEach(function (p) { if (p.id === playerId) player = p; });
    var el = tokenEls[playerId];
    dice.rollTo(plan.roll, CFG.DICE_ANIM_MS);
    Sound.dice();
    if (player) $('actionLine').textContent = I18n.t('tv.rolledInfo', { name: player.name, roll: plan.roll });
    if (!el || !window.gsap) { return; }

    animatingId = playerId;
    gsap.killTweensOf(el);
    var tl = gsap.timeline({
      onComplete: function () {
        animatingId = null;
        tl.kill();
        if (pendingSnap) { pendingSnap = false; snapTokens(null); }
      },
    });
    tl.to({}, { duration: CFG.DICE_ANIM_MS / 1000 }); // wait out dice tumble

    // Build positions against the CURRENT snapshot (server already moved
    // the player) — derive each intermediate square from the plan path.
    var others = state.players;
    plan.path.forEach(function (sq, i) {
      var probe = Object.assign({}, player, { position: sq });
      var px = posToPx(tokenPos(probe, others));
      tl.to(el, { x: px.x, y: px.y, duration: STEP() / 1000, ease: 'power1.inOut',
        onStart: function () { Sound.step(i); } }, '>');
      tl.fromTo(el, { scale: 1.18 }, { scale: 1, duration: STEP() / 2000, ease: 'power1.out' }, '<');
    });

    if (plan.feature) {
      var dest = Object.assign({}, player, { position: plan.finalPosition });
      var dpx = posToPx(tokenPos(dest, others));
      if (plan.feature.type === 'snake') {
        tl.add(function () { Sound.snake(); }, '>');
        tl.to(el, { x: dpx.x, duration: SLIDE() / 1000, ease: 'sine.inOut' }, '<');
        tl.to(el, { y: dpx.y, duration: SLIDE() / 1000, ease: 'power2.in' }, '<');
        tl.to(el, { rotation: 360, duration: SLIDE() / 1000, ease: 'sine.inOut' }, '<');
        tl.set(el, { rotation: 0 });
      } else {
        tl.add(function () { Sound.ladder(); }, '>');
        tl.to(el, { x: dpx.x, y: dpx.y, duration: SLIDE() / 1000, ease: 'power2.out' }, '<');
      }
    }
    if (plan.extraRoll) tl.add(function () { Sound.six(); });
    if (plan.overshot) tl.add(function () { Sound.miss(); });
  }

  // ── confetti (capped, transform-only, cleaned up — spec §2.2/§4) ──
  function confetti() {
    if (!window.gsap) return;
    var box = $('confetti');
    var count = lowFx ? 16 : 60;
    var colors = CFG.COLORS.map(function (c) { return c.hex; });
    for (var i = 0; i < count; i++) {
      var p = document.createElement('i');
      p.style.background = colors[i % colors.length];
      p.style.left = (Math.random() * 100) + 'vw';
      box.appendChild(p);
      gsap.fromTo(p, { y: -40, rotation: 0, autoAlpha: 1 }, {
        y: window.innerHeight * (0.55 + Math.random() * 0.5),
        x: '+=' + (Math.random() * 160 - 80),
        rotation: Math.random() * 540 - 270,
        duration: 2.2 + Math.random() * 1.6,
        delay: Math.random() * 0.5,
        ease: 'power1.in',
        onComplete: (function (node) { return function () { node.remove(); }; })(p),
      });
      gsap.to(p, { autoAlpha: 0, delay: 3 + Math.random(), duration: 0.6 });
    }
  }

  // ── render switchboard ─────────────────────────────────────────────
  function render() {
    if (!state) return;
    clockOffset = state.serverNow ? (state.serverNow - Date.now()) : clockOffset;

    $('createBox').hidden = roomCreated;
    $('joinBox').hidden = !roomCreated;
    $('lobbyCard').hidden = state.phase === 'IN_PROGRESS';
    $('turnCard').hidden = state.phase !== 'IN_PROGRESS';

    drawBoard(state.board);
    localizeBoardNumbers();
    renderPlayers();
    ensureTokens();
    if (animatingId) { pendingSnap = true; snapTokens(animatingId); }
    else snapTokens(null);
    updateTurnHeader();

    if (state.phase === 'GAME_OVER' && state.winnerId) showWinner();
    else $('winnerOverlay').hidden = true;
  }

  function updateTurnHeader() {
    if (state.phase !== 'IN_PROGRESS') return;
    var cur = null;
    state.players.forEach(function (p) { if (p.id === state.turnPlayerId) cur = p; });
    if (!cur) return;
    $('turnAvatar').textContent = cur.avatar;
    $('turnTitle').textContent = I18n.t('tv.turnOf', { name: cur.name });
    $('turnTitle').setAttribute('dir', 'auto');
    if (state.turnPhase === 'AWAITING_ROLL') {
      $('actionLine').textContent = I18n.t('tv.waitingRoll', { name: cur.name });
    }
  }

  function showWinner() {
    var w = null;
    state.players.forEach(function (p) { if (p.id === state.winnerId) w = p; });
    if (!w) return;
    $('winnerAvatar').textContent = w.avatar;
    $('winnerName').textContent = w.name;
    $('winnerOverlay').hidden = false;
  }

  // ── turn countdown (rAF; server deadline + clock offset) ──────────
  (function tick() {
    requestAnimationFrame(tick);
    if (!state || state.phase !== 'IN_PROGRESS' || !state.turnEndsAt) {
      $('timerNum').textContent = '';
      return;
    }
    var remain = Math.max(0, state.turnEndsAt - (Date.now() + clockOffset));
    var sec = Math.ceil(remain / 1000);
    var num = $('timerNum');
    var txt = I18n.fmt(sec);
    if (num.textContent !== txt) num.textContent = txt;
    var frac = remain / (SL.CONFIG.TURN_SECONDS * 1000);
    var fill = $('timerFill');
    fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, frac)) + ')';
    fill.classList.toggle('urgent', sec <= 5);
  })();

  // ── low-effects: FPS probe + manual toggle (spec §2.2) ────────────
  function setLowFx(on, persist) {
    lowFx = on;
    document.body.classList.toggle('low-fx', on);
    $('fxBtn').textContent = on ? I18n.t('tv.on') : I18n.t('tv.off');
    if (persist) { try { localStorage.setItem('sl-lowfx', on ? '1' : '0'); } catch (e) {} }
  }
  (function fpsProbe() {
    var frames = 0, t0 = performance.now();
    function frame() {
      frames++;
      var now = performance.now();
      if (now - t0 >= 3000) {
        var fps = frames / ((now - t0) / 1000);
        if (fps < 30 && !lowFx) setLowFx(true, false); // auto, session only
        return; // probe once at boot; TVs don't get faster mid-session
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  })();

  // ── controls ───────────────────────────────────────────────────────
  function refreshLangSeg() {
    var btns = $('langSeg').querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-lang') === I18n.lang);
    }
  }
  $('langSeg').addEventListener('click', function (e) {
    var lang = e.target.getAttribute && e.target.getAttribute('data-lang');
    if (!lang) return;
    Sound.unlock();
    I18n.setLang(lang).then(refreshLangSeg);
    if (roomCreated) sock.send(SL.C2S.HOST_SET_LANG, { lang: lang }); // room language → phones
  });
  function refreshSoundBtn() { $('soundBtn').textContent = Sound.isMuted() ? '🔇' : '🔊'; }
  $('soundBtn').addEventListener('click', function () {
    Sound.setMuted(!Sound.isMuted());
    refreshSoundBtn();
    if (!Sound.isMuted()) { Sound.unlock(); Sound.startAmbient(); }
  });
  $('fxBtn').addEventListener('click', function () { setLowFx(!lowFx, true); });

  $('createBtn').addEventListener('click', function () {
    Sound.unlock(); Sound.startAmbient();
    $('createBtn').disabled = true;
    $('createBtn').textContent = I18n.t('tv.creating');
    sock.send(SL.C2S.HOST_CREATE, { lang: I18n.lang });
  });
  $('startBtn').addEventListener('click', function () { sock.send(SL.C2S.HOST_START, {}); });
  $('rematchBtn').addEventListener('click', function () { sock.send(SL.C2S.HOST_REMATCH, {}); });

  // D-pad spatial navigation for TV remotes (arrows + Enter via native
  // button activation). Chooses the nearest focusable in that direction.
  document.addEventListener('keydown', function (e) {
    var dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    var d = dirs[e.key];
    if (!d) return;
    if (document.documentElement.dir === 'rtl' && d[1] === 0) d = [-d[0], 0]; // mirror L/R in RTL UI
    var els = Array.prototype.slice.call(document.querySelectorAll('[data-focus]'))
      .filter(function (el) { return el.offsetParent !== null && !el.disabled; });
    if (!els.length) return;
    var cur = document.activeElement;
    if (els.indexOf(cur) === -1) { els[0].focus(); e.preventDefault(); return; }
    var cr = cur.getBoundingClientRect();
    var cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    var best = null, bestScore = Infinity;
    els.forEach(function (el) {
      if (el === cur) return;
      var r = el.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      var dx = x - cx, dy = y - cy;
      if (dx * d[0] + dy * d[1] <= 4) return;              // wrong direction
      var primary = Math.abs(dx * d[0] + dy * d[1]);
      var secondary = Math.abs(dx * d[1] - dy * d[0]);
      var score = primary + secondary * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (best) { best.focus(); e.preventDefault(); }
  });

  // Guarantee a square board even on engines without CSS min() /
  // aspect-ratio (older Tizen/webOS): size it in px from the wrap box.
  function fitBoard() {
    var wrap = document.querySelector('.board-wrap');
    var board = $('board');
    if (!wrap || !board) return;
    var size = Math.max(240, Math.min(wrap.clientWidth, wrap.clientHeight - 30));
    board.style.width = size + 'px';
    board.style.height = size + 'px';
  }
  window.addEventListener('resize', function () {
    fitBoard();
    if (state) snapTokens(animatingId);
  });

  // ── socket wiring ──────────────────────────────────────────────────
  sock.on(SL.S2C.ROOM_CREATED, function (msg) {
    roomCreated = true;
    state = msg.state;
    $('qrBox').innerHTML = msg.qrSvg;         // server-generated QR (SVG)
    $('joinUrl').textContent = msg.joinUrl;
    $('roomCode').textContent = msg.roomCode;
    $('createBtn').disabled = false;
    I18n.apply(document);
    render();
  });
  sock.on(SL.S2C.STATE, function (msg) {
    var prevTurn = state && state.turnPlayerId;
    state = msg.state;
    if (state.lang && state.lang !== I18n.lang) {
      I18n.setLang(state.lang, { skipPersist: false }).then(function () { refreshLangSeg(); render(); });
      return;
    }
    if (prevTurn && state.turnPlayerId && prevTurn !== state.turnPlayerId &&
        state.phase === 'IN_PROGRESS') Sound.turn();
    render();
  });
  sock.on(SL.S2C.DICE_ROLLED, function (msg) {
    clockOffset = msg.serverNow - Date.now();
    if (state) animatePlan(msg.playerId, msg.plan);
  });
  sock.on(SL.S2C.TURN, function (msg) {
    if (state) { state.turnPlayerId = msg.turnPlayerId; state.turnEndsAt = msg.turnEndsAt; }
    clockOffset = msg.serverNow - Date.now();
  });
  sock.on(SL.S2C.ANNOUNCE, function (msg) {
    toast(msg.key, msg.params);
    if (msg.key === 'announce.playerJoined') Sound.join();
    if (msg.key === 'announce.turnMissed' || msg.key === 'announce.playerRemoved') Sound.miss();
    if (msg.key === 'announce.winner') { Sound.win(); confetti(); }
  });
  sock.on(SL.S2C.ERROR, function (msg) { toast(msg.key, msg.params); });
  sock.onStatus(function (connected) {
    document.body.style.opacity = connected ? '' : '0.55';
  });
  // If the TV socket dies and reconnects, its room host binding is gone
  // on the server — offer a fresh game rather than a zombie screen [A5].
  sock.onReopen(function () {
    if (!roomCreated) return;
    roomCreated = false;
    tokenEls = {};
    $('tokens').innerHTML = '';
    $('createBtn').disabled = false;
    I18n.apply(document);
    state = null;
    $('lobbyCard').hidden = false;
    $('turnCard').hidden = true;
    $('createBox').hidden = false;
    $('joinBox').hidden = true;
    $('players').innerHTML = '';
    drawBoard(null);
  });

  // ── boot ───────────────────────────────────────────────────────────
  I18n.onChange(function () {
    refreshLangSeg();
    localizeBoardNumbers();
    setLowFx(lowFx, false);
    if (state) render();
    else $('playersTitle').textContent = I18n.t('tv.waitingPlayers');
  });
  I18n.setLang(I18n.detect()).then(function () {
    refreshLangSeg();
    refreshSoundBtn();
    setLowFx(lowFx, false);
    localizeBoardNumbers();
    fitBoard();
  });
  sock.connect();
})();
