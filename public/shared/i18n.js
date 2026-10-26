/**
 * public/shared/i18n.js — tiny bilingual (EN/FA) runtime, shared by the
 * TV and mobile clients (spec §4.1). Deliberately dependency-free and
 * written in conservative JS for older Smart TV Chromium engines.
 *
 *  - Strings live ONLY in /locales/<lang>.json — no hard-coded UI text.
 *    Adding a language = adding one JSON file (+ SUPPORTED_LANGS entry).
 *  - t(key, params): "{name} rolled {roll}" interpolation. Numeric
 *    params are auto-formatted (Persian digits in fa mode).
 *  - Static labels:  <span data-i18n="tv.startGame">, placeholders via
 *    data-i18n-ph. apply() rewrites them IN PLACE on language switch —
 *    no reload, no full re-render (spec §5).
 *  - Sets <html lang dir> so CSS logical properties flip the layout.
 *    The board and dice are never mirrored (spec §4.1): they are inside
 *    dir="ltr" islands, see tv.js.
 */
(function () {
  'use strict';
  var FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

  var I18n = {
    lang: 'en',
    dict: {},
    fallback: {},
    _listeners: [],

    /** Format a number for display: Persian digits under fa (manual map —
     *  older TV Intl builds cannot be trusted to have fa numbering). */
    fmt: function (n) {
      var s = String(n);
      if (I18n.lang !== 'fa') return s;
      return s.replace(/[0-9]/g, function (d) { return FA_DIGITS[+d]; });
    },

    t: function (key, params) {
      var s = I18n.dict[key];
      if (s == null) s = I18n.fallback[key];
      if (s == null) return key; // visible key beats a blank in dev
      if (params) {
        s = s.replace(/\{(\w+)\}/g, function (_m, name) {
          var v = params[name];
          if (v == null) return '';
          return typeof v === 'number' ? I18n.fmt(v) : String(v);
        });
      }
      return s;
    },

    onChange: function (fn) { I18n._listeners.push(fn); },

    _load: function (lang) {
      var url = '/locales/' + lang + '.json';
      if (typeof fetch === 'function') {
        return fetch(url, { cache: 'force-cache' })
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
          .catch(function () { return {}; });
      }
      // XHR fallback for very old TV Chromium engines without fetch.
      return new Promise(function (resolve) {
        try {
          var x = new XMLHttpRequest();
          x.open('GET', url, true);
          x.onreadystatechange = function () {
            if (x.readyState === 4) {
              try { resolve(x.status === 200 ? JSON.parse(x.responseText) : {}); }
              catch (e) { resolve({}); }
            }
          };
          x.onerror = function () { resolve({}); };
          x.send();
        } catch (e) { resolve({}); }
      });
    },

    /** Load (once) and switch. Keeps `en` as the permanent fallback dict. */
    setLang: function (lang, opts) {
      if (window.SL && SL.CONFIG.SUPPORTED_LANGS.indexOf(lang) === -1) lang = 'en';
      var jobs = [I18n._load(lang)];
      if (lang !== 'en' && !Object.keys(I18n.fallback).length) jobs.push(I18n._load('en'));
      return Promise.all(jobs).then(function (res) {
        if (lang === 'en') { I18n.dict = res[0]; I18n.fallback = res[0]; }
        else { I18n.dict = res[0]; if (res[1]) I18n.fallback = res[1]; }
        I18n.lang = lang;
        var html = document.documentElement;
        html.lang = lang;
        html.dir = lang === 'fa' ? 'rtl' : 'ltr';
        if (!opts || !opts.skipPersist) {
          try { localStorage.setItem('sl-lang', lang); } catch (e) {}
        }
        I18n.apply(document);
        I18n._listeners.forEach(function (fn) { try { fn(lang); } catch (e) {} });
      });
    },

    apply: function (root) {
      var nodes = root.querySelectorAll('[data-i18n]');
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].textContent = I18n.t(nodes[i].getAttribute('data-i18n'));
      }
      var ph = root.querySelectorAll('[data-i18n-ph]');
      for (var j = 0; j < ph.length; j++) {
        ph[j].setAttribute('placeholder', I18n.t(ph[j].getAttribute('data-i18n-ph')));
      }
    },

    /** localStorage → navigator.language → English (spec §4.1). */
    detect: function () {
      try {
        var saved = localStorage.getItem('sl-lang');
        if (saved) return saved;
      } catch (e) {}
      var nav = (navigator.language || 'en').toLowerCase();
      return nav.indexOf('fa') === 0 ? 'fa' : 'en';
    },
  };

  window.I18n = I18n;
})();
