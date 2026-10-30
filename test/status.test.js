'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { describeStatus } = require('../public/status');

test('monitoring severity separates healthy, partial, stale and failed observations', () => {
  for (const [state, severity] of [['Live', 'healthy'], ['Connecting', 'info'], ['Degraded', 'warning'], ['Stale', 'high'], ['Reconnecting', 'high'], ['Error', 'critical']]) {
    const result = describeStatus({ state }); assert.equal(result.severity, severity); assert.ok(result.description); assert.ok(result.reasons.length);
  }
  assert.equal(describeStatus({ state: 'Degraded', model: { health: { providers: [{ id: 'codex', status: 'error' }] } } }).severity, 'high');
  assert.equal(describeStatus({ state: 'Live', detail: 'Some data unavailable' }).severity, 'warning');
});

test('status explains limits and unreadable stores without asserting that agents failed', () => {
  const status = describeStatus({ state: 'Degraded', model: { health: { diagnostics: ['FILE_LIMIT', 'RECORD_LIMIT', 'SOURCE_UNAVAILABLE', 'FILES_UNREADABLE'], providers: [{ id: 'codex', status: 'degraded' }, { id: 'copilot-vscode', status: 'ok' }] }, unreadableFiles: 2, sources: [{ provider: 'codex', directory: '/store/codex', status: 'unreadable' }] } });
  assert.match(status.reasons.find(reason => reason.code === 'FILE_LIMIT').text, /file-size limit/);
  assert.match(status.reasons.find(reason => reason.code === 'RECORD_LIMIT').text, /record-size limit/);
  assert.ok(status.reasons.some(reason => reason.path === '/store/codex'));
  assert.ok(status.reasons.some(reason => reason.text.startsWith('2 transcript files')));
  assert.equal(status.providers[1].name, 'VS Code Copilot');
});

test('status recovery clears old reasons and safely describes unknown diagnostics', () => {
  const healthy = describeStatus({ state: 'Live', model: { health: { diagnostics: [] }, sources: [{ status: 'missing' }] } });
  assert.equal(healthy.severity, 'healthy'); assert.equal(healthy.reasons.length, 1);
  const future = describeStatus({ state: 'Degraded', model: { health: { diagnostics: ['FUTURE_LIMIT', 'PRIVATE error message'] } } });
  assert.equal(future.reasons[0].code, 'FUTURE_LIMIT'); assert.equal(future.reasons[1].code, 'UNKNOWN_DIAGNOSTIC');
  assert.equal(JSON.stringify(future).includes('PRIVATE'), false);
  assert.ok(describeStatus({ state: 'Error', code: 'SCAN_FAILED' }).reasons.some(reason => reason.code === 'SCAN_FAILED'));
});

test('status pairs each affected file with its failure reason and provider', () => {
  const status = describeStatus({ state: 'Degraded', model: { health: { diagnostics: ['FILE_LIMIT', 'MALFORMED_RECORD'], fileIssues: [
    { file: '/codex/rollout-large.jsonl', code: 'FILE_LIMIT', provider: 'codex' },
    { file: '/copilot/session.jsonl', code: 'MALFORMED_RECORD', provider: 'copilot-vscode' }
  ], omittedFileIssues: 4 } } });
  assert.deepEqual(status.reasons[0], { code: 'FILE_LIMIT', text: 'Codex: A transcript file exceeds the configured file-size limit and was skipped.', path: '/codex/rollout-large.jsonl' });
  assert.match(status.reasons[1].text, /VS Code Copilot:.*invalid transcript record/);
  assert.equal(status.reasons[1].path, '/copilot/session.jsonl');
  assert.match(status.reasons[2].text, /4 additional file issues/);
  assert.equal(status.reasons.length, 3, 'file explanations are not repeated without their paths');
  assert.equal(describeStatus({ state: 'Live', model: { health: {} } }).reasons.some(reason => reason.path), false);
});

test('explains a file that cannot fit the per-scan read budget', () => {
  const status = describeStatus({ state: 'Degraded', model: { health: { fileIssues: [{ file: '/store/large', code: 'READ_BUDGET_LIMIT', provider: 'codex' }] } } });
  assert.match(status.reasons[0].text, /cannot fit.*Increase/);
});
