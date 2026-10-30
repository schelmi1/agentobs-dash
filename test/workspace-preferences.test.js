'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreferenceStore } = require('../public/preferences');
test('workspace arrangement is validated and survives preference writes and reloads', () => {
  let value = '{}'; const storage = { getItem: () => value, setItem: (_, next) => { value = next; } };
  const store = createPreferenceStore(storage);
  assert.equal(store.get().modernWorkspaceArrangement, 'column');
  store.set({ modernWorkspaceArrangement: 'grid', modernWorkspaceSizes: { a: { span: 6, height: 800 } } });
  store.set({ colors: 'light', search: 'tool' });
  const reloaded = createPreferenceStore(storage).get();
  assert.equal(reloaded.modernWorkspaceArrangement, 'grid');
  assert.deepEqual(reloaded.modernWorkspaceSizes.a, { span: 6, height: 800 });
  store.set({ modernWorkspaceArrangement: 'invalid' });
  assert.equal(store.get().modernWorkspaceArrangement, 'column');
});
