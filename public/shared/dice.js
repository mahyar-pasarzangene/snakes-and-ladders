/**
 * public/shared/dice.js — synchronized dice widget (spec §3/§4).
 * The server decides the result; TV and the rolling phone both receive
 * it in `dice:rolled` and run this identical tumble (random intermediate
 * faces, transform-only GSAP motion) settling on the same face at the
 * same budget (SL.CONFIG.DICE_ANIM_MS). Falls back to a plain timed
 * face-swap if GSAP somehow failed to load (spec §2.2 fallback rule).
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
    this.setFace(6);
  }

  Dice.prototype.setFace = function (n) {
    this.face = n;
    this.el.className = 'dice face-' + n;
    var on = PIPS[n] || [];
    for (var i = 0; i < 9; i++) {
      this.pips[i].className = 'pip' + (on.indexOf(i) !== -1 ? ' on' : '');
    }
  };

  /** Animate a tumble ending on `result`. Calls done() when settled. */
  Dice.prototype.rollTo = function (result, durationMs, done) {
    var self = this;
    clearInterval(this._iv);
    var swaps = Math.max(4, Math.floor(durationMs / 90));
    var count = 0;
    this._iv = setInterval(function () {
      count++;
      self.setFace(1 + Math.floor(Math.random() * 6));
      if (count >= swaps) {
        clearInterval(self._iv);
        self.setFace(result);
        if (window.gsap) {
          gsap.fromTo(self.el, { scale: 1.25 }, { scale: 1, duration: 0.25, ease: 'back.out(2)' });
        }
        if (done) done();
      }
    }, 90);

    if (window.gsap) {
      gsap.fromTo(self.el,
        { rotation: -14, scale: 0.9 },
        { rotation: 12, scale: 1.12, duration: durationMs / 2000, yoyo: true, repeat: 1, ease: 'sine.inOut' });
    }
  };

  Dice.prototype.stop = function () {
    clearInterval(this._iv);
    if (window.gsap) gsap.killTweensOf(this.el);
  };

  window.Dice = Dice;
})();
