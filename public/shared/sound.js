/**
 * public/shared/sound.js — synthesized sound design (Web Audio, zero
 * audio files). Rationale: keeps the bundle tiny, works offline on a LAN,
 * and every sound is language-neutral (spec §4). All sounds are short
 * oscillator/noise envelopes; the ambient pad is two quiet detuned
 * triangles. Everything is guarded: a TV without WebAudio just plays
 * silently. AudioContext is created lazily on the first user gesture
 * (autoplay policy) via Sound.unlock().
 */
(function () {
  'use strict';
  var ctx = null, master = null, ambientNodes = null;
  var muted = false;
  try { muted = localStorage.getItem('sl-muted') === '1'; } catch (e) {}

  function ensure() {
    if (ctx || muted) return !!ctx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      return true;
    } catch (e) { return false; }
  }

  function tone(freqA, freqB, dur, delay, type, vol) {
    if (!ensure()) return;
    var t0 = ctx.currentTime + (delay || 0);
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freqA, t0);
    if (freqB && freqB !== freqA) o.frequency.exponentialRampToValueAtTime(freqB, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.25, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  function noiseBurst(dur, delay, vol) {
    if (!ensure()) return;
    var t0 = ctx.currentTime + (delay || 0);
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource(); src.buffer = buf;
    var f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1500;
    var g = ctx.createGain(); g.gain.value = vol || 0.15;
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0);
  }

  var Sound = {
    unlock: function () { if (ensure() && ctx.state === 'suspended') ctx.resume(); },
    isMuted: function () { return muted; },
    setMuted: function (m) {
      muted = m;
      try { localStorage.setItem('sl-muted', m ? '1' : '0'); } catch (e) {}
      if (m) Sound.stopAmbient();
      if (master) master.gain.value = m ? 0 : 0.5;
    },
    dice: function () { for (var i = 0; i < 6; i++) noiseBurst(0.05, i * 0.11, 0.12); tone(320, 180, 0.08, 0.66, 'triangle', 0.18); },
    step: function (i) { tone(420 + (i % 6) * 40, 420 + (i % 6) * 40, 0.07, 0, 'triangle', 0.12); },
    snake: function () { tone(700, 140, 0.65, 0, 'sine', 0.22); noiseBurst(0.5, 0, 0.05); },
    ladder: function () { [523, 659, 784, 1046].forEach(function (f, i) { tone(f, f, 0.14, i * 0.09, 'triangle', 0.18); }); },
    turn: function () { tone(880, 880, 0.1, 0, 'sine', 0.14); tone(1174, 1174, 0.14, 0.1, 'sine', 0.14); },
    join: function () { tone(659, 659, 0.09, 0, 'triangle', 0.15); tone(988, 988, 0.12, 0.09, 'triangle', 0.15); },
    miss: function () { tone(220, 160, 0.25, 0, 'sawtooth', 0.07); },
    six: function () { tone(1046, 1046, 0.1, 0, 'square', 0.08); tone(1568, 1568, 0.16, 0.09, 'square', 0.08); },
    win: function () {
      [523, 659, 784, 1046, 784, 1046, 1318].forEach(function (f, i) { tone(f, f, 0.22, i * 0.14, 'triangle', 0.2); });
      noiseBurst(0.4, 0.9, 0.08);
    },
    startAmbient: function () {
      if (!ensure() || ambientNodes) return;
      var g = ctx.createGain(); g.gain.value = 0.035; g.connect(master);
      var o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
      o1.type = 'triangle'; o2.type = 'triangle';
      o1.frequency.value = 196; o2.frequency.value = 294.5;
      var lfo = ctx.createOscillator(), lfoG = ctx.createGain();
      lfo.frequency.value = 0.08; lfoG.gain.value = 18;
      lfo.connect(lfoG); lfoG.connect(o2.frequency);
      o1.connect(g); o2.connect(g);
      o1.start(); o2.start(); lfo.start();
      ambientNodes = { o1: o1, o2: o2, lfo: lfo, g: g };
    },
    stopAmbient: function () {
      if (!ambientNodes) return;
      try { ambientNodes.o1.stop(); ambientNodes.o2.stop(); ambientNodes.lfo.stop(); ambientNodes.g.disconnect(); } catch (e) {}
      ambientNodes = null;
    },
  };

  window.Sound = Sound;
})();
