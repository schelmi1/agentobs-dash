'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { designs, themes, colors, normalizeAppearance, paletteVariables } = require('../public/appearance');

test('legacy presets migrate into layout, visual theme and color selections', () => {
  const expected = {
    default: ['tree', 'rounded', 'dark'], chamfered: ['tree', 'chamfered', 'dark'],
    paper: ['tree', 'rounded', 'light'], terminal: ['tree', 'terminal', 'dark'],
    blueprint: ['tree', 'rounded', 'dark'], signal: ['signal', 'rounded', 'dark'], orbit: ['orbit', 'rounded', 'dark']
  };
  for (const [theme, [, shape, palette]] of Object.entries(expected)) assert.deepEqual(normalizeAppearance({ theme }), { design: 'modern', theme: shape, colors: palette });
  for (const invalid of [null, [], {}, { theme: '__proto__' }, { theme: 'future-preset' }, { theme: ['orbit'] }, { theme: { toString: null } }]) assert.deepEqual(normalizeAppearance(invalid), { design: 'modern', theme: 'rounded', colors: 'dark' });
});

test('previous split preferences move presentation designs into themes and preserve chosen colors', () => {
  for (const design of ['paper', 'terminal', 'blueprint']) for (const shape of ['rounded', 'chamfered']) {
    const saved = { design, theme: shape, colors: 'dark-plus', selectedWorkspace: '/projects/demo' };
    assert.deepEqual(normalizeAppearance(saved), { design: 'modern', theme: design === 'terminal' ? 'terminal' : 'rounded', colors: 'dark-plus' });
    assert.equal(saved.design, design, 'normalization does not mutate stored preferences');
  }
});

test('all layouts, visual themes and palettes can be combined without selecting defaults for other axes', () => {
  for (const design of designs) for (const theme of themes) for (const palette of colors) {
    const selection = { design: design.id, theme: theme.id, colors: palette.id };
    assert.deepEqual(normalizeAppearance(selection), selection);
  }
  assert.deepEqual(normalizeAppearance({ design: 'invalid', theme: 'chamfered', colors: 'dark-plus' }), { design: 'modern', theme: 'chamfered', colors: 'dark-plus' });
  assert.deepEqual(normalizeAppearance({ design: 'orbit', theme: 'invalid', colors: 'light' }), { design: 'modern', theme: 'rounded', colors: 'light' });
  for (const theme of ['paper', 'blueprint']) {
    assert.deepEqual(normalizeAppearance({ design: 'modern', theme, colors: 'monokai' }), { design: 'modern', theme: 'rounded', colors: 'monokai' });
  }
});

test('eight color themes provide readable body text and contrast-aware solid-label ink', () => {
  const luminance = hex => hex.match(/\w{2}/g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => { const values = [luminance(a), luminance(b)].sort((a, b) => b - a); return (values[0] + .05) / (values[1] + .05); };
  assert.deepEqual(colors.map(palette => palette.id), ['dark', 'light', 'dark-plus', 'light-plus', 'solarized-light', 'monokai', 'linux-mint', 'ubuntu']);
  assert.equal(colors.find(palette => palette.id === 'ubuntu').type, 'Terminal');
  assert.equal(new Set(colors.map(palette => palette.id)).size, colors.length);
  for (const palette of colors) {
    for (const field of ['background', 'sidebar', 'card', 'foreground', 'muted', 'border', 'accent', 'green', 'amber', 'red', 'input']) assert.match(palette[field], /^#[a-f\d]{6}$/i, palette.id + ' ' + field);
    const variables = paletteVariables(palette.id);
    assert.equal(variables['--vscode-editor-background'], palette.background);
    assert.equal(variables['--vscode-foreground'], palette.foreground);
    assert.ok(contrast(palette.foreground, palette.background) >= 4.5, palette.id + ' body text');
    for (const [color, ink] of [['accent', 'accent'], ['green', 'green'], ['amber', 'amber'], ['red', 'red'], ['muted', 'muted']]) assert.ok(contrast(palette[color], variables['--' + ink + '-ink']) >= 4.5, palette.id + ' ' + ink + ' label');
  }
});

test('retired palettes migrate without changing the selected design or visual theme', () => {
  const light = ['paper', 'quiet-light'];
  const dark = ['solarized-dark', 'high-contrast', 'observatory', 'brass', 'phosphor', 'blueprint', 'ember', 'violet', 'unknown'];
  for (const colors of [...light, ...dark]) {
    assert.deepEqual(normalizeAppearance({ design: 'orbit', theme: 'chamfered', colors }), {
      design: 'modern', theme: 'chamfered', colors: light.includes(colors) ? 'light' : 'dark'
    });
  }
  assert.deepEqual(paletteVariables('removed-palette'), paletteVariables('dark'));
});
