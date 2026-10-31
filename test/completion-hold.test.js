'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCompletionHold } = require('../public/completion-hold');
const selectors = require('../public/selectors');
const storage = () => { const data = new Map(); return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) }; };
const node = (id, displayState, children = []) => ({ id, displayState, archived: displayState === 'completed', children });

test('only newly completed workspaces are held for 30 seconds, including across reload', () => {
  const store = storage(); let hold = createCompletionHold(store, selectors);
  const active = node('run', 'working'), done = node('run', 'completed'), old = node('old', 'completed');
  assert.equal(hold.update([active, old], 1000).forest[1].completionHeld, undefined);
  let result = hold.update([done, old], 2000);
  assert.equal(result.forest[0].completionHeld, true); assert.equal(result.nextExpiry, 32000);
  assert.equal(result.forest[0].archived, true, 'the real completed status is retained');
  hold = createCompletionHold(store, selectors);
  assert.equal(hold.update([done, old], 31999).forest[0].completionHeld, true);
  assert.equal(hold.update([done, old], 32000).forest[0].completionHeld, undefined);
});

test('resumed work cancels the hold and can complete again', () => {
  const hold = createCompletionHold(storage(), selectors), active = node('run', 'working'), done = node('run', 'completed');
  hold.update([active], 0); hold.update([done], 1000);
  assert.equal(hold.update([active], 2000).nextExpiry, undefined);
  assert.equal(hold.update([done], 3000).nextExpiry, 33000);
  assert.equal(hold.update([], 4000).nextExpiry, undefined);
});

test('failed, manually moved, and unfinished descendant workspaces are not marked completed', () => {
  const hold = createCompletionHold(storage(), selectors), active = node('run', 'working');
  hold.update([active], 0);
  assert.equal(hold.update([{ ...node('run', 'completed'), manuallyCompleted: true }], 1).nextExpiry, undefined);
  hold.update([active], 2);
  assert.equal(hold.update([node('run', 'completed', [node('child', 'working')])], 3).nextExpiry, undefined);
  assert.equal(hold.update([node('run', 'failed')], 4).nextExpiry, undefined);
});

test('configured durations control completion, including zero for immediate history', () => {
  const hold = createCompletionHold(storage(), selectors), active = node('run', 'working'), done = node('run', 'completed');
  hold.update([active], 1000, 12000);
  assert.equal(hold.update([done], 2000, 12000).nextExpiry, 14000);
  hold.update([active], 3000, 0);
  assert.equal(hold.update([done], 4000, 0).forest[0].completionHeld, undefined);
});
