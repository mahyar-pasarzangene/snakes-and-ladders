'use strict';
/**
 * Static regressions for the dice pip layout on BOTH displays.
 *
 * The TV fix made the die a non-shrinking square with a compound
 * `#diceEl.dice` size rule. The phone still rendered the pips incorrectly
 * because the shared widget inset its 3×3 grid with `padding: 12%`:
 * percentage padding is resolved against the flex container's width, not
 * the die's own size. On the phone stage that left the pips clustered and
 * tiny (and could collapse them entirely on a wide TV panel).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ruleBody = (css, selector) => {
  const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} rule must exist`);
  return match[1];
};

test('the shared die insets its pip grid relative to its own size', () => {
  const css = read('public/shared/dice.css');
  const dice = ruleBody(css, '\\.dice');

  assert.match(dice, /flex:\s*none/, 'the die must stay square in a flex row');
  assert.doesNotMatch(
    dice,
    /padding:\s*\d*\.?\d+%/,
    'percentage padding follows the parent width and collapses the pip grid');
  assert.match(
    dice,
    /padding:\s*calc\(var\(--dice-size\)\s*\*\s*0?\.12\)/,
    'the pip grid must scale with --dice-size, as on the TV');
  assert.match(dice, /padding:\s*12px/, 'keep a px fallback for older engines');
});

test('TV and player views both load the shared dice widget and size it', () => {
  for (const [name, html, css] of [
    ['TV', 'public/tv/index.html', 'public/tv/tv.css'],
    ['mobile', 'public/mobile/index.html', 'public/mobile/mobile.css'],
  ]) {
    const markup = read(html);
    assert.match(markup, /href="\/assets\/dice\.css"/, `${name} must load the shared pip styles`);
    assert.match(markup, /src="\/assets\/dice\.js"/, `${name} must load the shared face renderer`);
    assert.match(markup, /id="diceEl"/, `${name} must have the die element`);

    const stylesheet = read(css);
    const sizeRule = ruleBody(stylesheet, '#diceEl\\.dice');
    assert.match(sizeRule, /--dice-size:/, `${name} must override the die size`);
  }
});
