/**
 * public/shared/dice.js — synchronized dice widget (spec §3/§4).
 * The server decides the result; TV and the rolling phone both receive
 * it in `dice:rolled` and run this identical tumble (random intermediate
 * faces, transform-only GSAP motion) settling on the same face at the
 * same budget (SL.CONFIG.DICE_ANIM_MS). Falls back to a plain timed
 * face-swap if GSAP somehow failed to load (spec §2.2 fallback rule).
 *
 * `dice:rolled` is a one-shot broadcast, so a client that was asleep,
 * reloaded mid-roll or briefly offline never sees it — a phone almost
 * always does at some point (screen lock, backgrounded tab, Wi-Fi blip),
 * which left that player's die showing a stale face while the TV showed
 * the real one. Every `room:state` snapshot therefore also carries
 * `lastRoll`, and `syncSnapshot()` lets any client adopt the face it
 * missed. See also `_lastRollId` below.
 */
(function () {
  'use strict';
  var PIPS = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };

  function Dice(el) {
    this.el = el;
    this.pips = [];
    el.classList.add('dice');
    el.setAttribute('dir', 'ltr'); // dice art is never mirrored (spec §4.1)
    for (var i = 0; i < 9; i++) {
      var p = document.createElement('span');
      p.className = 'pip';
      el.appendChild(p);
      this.pips.push(p);
    }
    this._iv = null;
    this._rollGeneration = 0;
    // Highest authoritative roll id this die already shows (or is
    // animating). Server ids are monotonic per room, so a snapshot can
    // never drag the die back to an older face.
    this._lastRollId = 0;
    this.setFace(6);
  }

  function isValidFace(n) {
    return Number.isInteger(n) && Object.prototype.hasOwnProperty.call(PIPS, n);
  }

  Dice.prototype.setFace = function (n) {
    // Never render a blank/partial die for a malformed or stale message.
    // The authoritative server always sends an integer from 1 through 6.
    if (!isValidFace(n)) return false;
    this.face = n;
    this.el.className = 'dice face-' + n;
    this.el.setAttribute('data-face', n);
    var on = PIPS[n];
    for (var i = 0; i < 9; i++) {
      this.pips[i].className = 'pip' + (on.indexOf(i) !== -1 ? ' on' : '');
    }
    return true;
  };

  /** Animate a tumble ending on `result`. Calls done() when settled.
   *  `rollId` (optional) is the server's monotonic id for this roll; it
   *  marks the face as current so a `room:state` snapshot for the same
   *  roll cannot cut the tumble short.
   *
   *  The rocking tween runs until the face settles, then is killed and
   *  the die is explicitly returned to rotation:0 / scale:1 — an earlier
   *  yoyo tween used to end on its FROM values, leaving every settled
   *  die permanently tilted at -14°. */
  Dice.prototype.rollTo = function (result, durationMs, done, rollId) {
    if (!isValidFace(result)) return false;
    if (typeof rollId === 'number' && rollId > this._lastRollId) this._lastRollId = rollId;
    var self = this;
    clearInterval(this._iv);
    this.stopRock();
    // clearInterval prevents future ticks, but a tick already queued by the
    // browser can still race a newly received roll. Generation-check each
    // callback so an older roll can never overwrite the current face.
    var generation = ++this._rollGeneration;
    var duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    var swaps = Math.max(4, Math.floor(duration / 90));
    var count = 0;
    this._iv = setInterval(function () {
      if (generation !== self._rollGeneration) return;
      count++;
      self.setFace(1 + Math.floor(Math.random() * 6));
      if (count >= swaps) {
        clearInterval(self._iv);
        self._iv = null;
        ++self._rollGeneration; // invalidate any duplicate/queued final tick
        self.setFace(result);
        self.stopRock();
        if (window.gsap) {
          gsap.fromTo(self.el, { scale: 1.18 }, {
            rotation: 0, scale: 1, duration: 0.3, ease: 'back.out(2)', overwrite: 'auto',
          });
        }
        if (done) done();
      }
    }, 90);

    if (window.gsap) {
      this._rock = gsap.fromTo(self.el,
        { rotation: -12, scale: 0.92 },
        { rotation: 10, scale: 1.08, duration: 0.18, yoyo: true, repeat: -1, ease: 'sine.inOut' });
    }
    return true;
  };

  Dice.prototype.stopRock = function () {
    if (this._rock) { this._rock.kill(); this._rock = null; }
  };

  /**
   * Adopt the authoritative face carried by a `room:state` snapshot's
   * `lastRoll` ({id, playerId, roll}). This is what keeps every player's
   * phone on the same face as the TV: the tumble rides a one-shot
   * `dice:rolled` broadcast, so any client that missed it (screen asleep,
   * tab backgrounded, reload mid-roll, Wi-Fi blip → reconnect) used to
   * keep the previous face — or the constructor's 6 — indefinitely.
   *
   * Deliberately NOT animated: the roll already happened, so the snapshot
   * only corrects a face the client missed. Returns true when it changed
   * the die. A no-op for a missing/invalid roll, or for a roll this die
   * already shows (a snapshot normally arrives right after `dice:rolled`,
   * and must not disturb the running tumble).
   */
  Dice.prototype.syncSnapshot = function (lastRoll) {
    if (!lastRoll || !isValidFace(lastRoll.roll)) return false;
    var id = typeof lastRoll.id === 'number' ? lastRoll.id : null;
    if (id !== null && id <= this._lastRollId) return false;
    this.stop(); // a newer authoritative face wins over an older tumble
    this.setFace(lastRoll.roll);
    if (id !== null) this._lastRollId = id;
    return true;
  };

  Dice.prototype.stop = function () {
    ++this._rollGeneration;
    clearInterval(this._iv);
    this._iv = null;
    this.stopRock();
    if (window.gsap) {
      gsap.killTweensOf(this.el);
      gsap.set(this.el, { rotation: 0, scale: 1 });
    }
  };

  window.Dice = Dice;
})();
