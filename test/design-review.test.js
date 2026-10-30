'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildSessionForest } = require('../lib/hierarchy');
const { Observer } = require('../lib/observer');
const { defaults } = require('../lib/config');
const { validateScan } = require('../lib/harnesses/contract');
const at = '2026-10-27T12:00:00Z';
const session = (id, fields = {}) => ({ id, cwd: '/workspace', provider: 'test', providerLabel: 'Test', status: 'active', lastActivity: at, ...fields });
const scan = (sessions, status = 'ready') => ({ sessions, sources: [{ directory: '/store', status }], unreadable: 0 });
async function temporary(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-s-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }

test('explicit run ancestry wins over another run claiming the same agent path', () => {
  const forest = buildSessionForest([
    session('a', { spawnedAgentPaths: ['/root/reviewer'], spawnedAgents: [{ agentPath: '/root/reviewer', task: 'Task A' }], completedAgentPaths: ['/root/reviewer'], agentObservations: [{ agentPath: '/root/reviewer', status: 'completed', timestamp: at }] }),
    session('b'), session('child-b', { parentId: 'b', agentPath: '/root/reviewer', currentTask: 'Task B' })
  ]);
  const child = forest.find(node => node.session.id === 'b').children[0].session;
  assert.equal(child.currentTask, 'Task B'); assert.equal(child.status, 'active');
});

test('providers with identical session ids and paths cannot join runs', () => {
  const forest = buildSessionForest([session('same', { spawnedAgentPaths: ['/root/child'] }), session('same', { provider: 'other', currentTask: 'Other' })]);
  assert.equal(forest.length, 2);
  assert.equal(Object.keys(require('../lib/live-map-model').liveMapModel(forest).agents).length, 3);
});

test('nested malformed adapter evidence is rejected before hierarchy construction', () => {
  for (const fields of [{ spawnedAgents: [null] }, { agentReports: [{ agentPath: '/root/child', spawnedAgentPaths: [42] }] }, { spawnedAgentPaths: [42] }, { agentObservations: [{ agentPath: '/root/child', timestamp: 'bad' }] }, { activityTimeline: [null] }]) {
    const result = validateScan(scan([session('bad', fields), session('good')]));
    assert.deepEqual(result.sessions.map(value => value.id), ['good']); assert.ok(result.diagnostics.includes('SESSION_INVALID'));
  }
});

test('child follow-up tasks survive older parent assignments', () => {
  const forest = buildSessionForest([session('parent', { spawnedAgentPaths: ['/root/child'], spawnedAgents: [{ agentPath: '/root/child', task: 'Original assignment', timestamp: '2026-10-27T10:00:00Z' }] }), session('child', { parentId: 'parent', agentPath: '/root/child', currentTask: 'Local follow-up', currentTaskAt: at })]);
  assert.equal(forest[0].children[0].session.currentTask, 'Local follow-up');
  assert.equal(forest[0].children[0].session.originalAssignment, 'Original assignment');
});

test('deep hierarchy preprocessing stays bounded before the display depth limit', () => {
  const sessions = Array.from({ length: 2000 }, (_, i) => session('shared', { agentPath: '/root' + '/a'.repeat(i) }));
  const start = performance.now(); buildSessionForest(sessions, { maxDepth: 10 });
  assert.ok(performance.now() - start < 1000, '2000 path links should not require repeated ancestry searches');
});

test('unavailable source coverage retains stale observations through subsequent rejection and removes confirmed deletions', async t => {
  const root = await temporary(t); let step = 0;
  const adapter = { roots: ['/store'], async scan() { if (step === 2) throw Error('offline'); return scan(step === 0 ? [session('one', { cwd: root, file: '/store/one', sourceDirectory: '/store' })] : [], step === 1 ? 'unreadable' : 'ready'); } };
  const observer = new Observer({ ...defaults, rootFolder: root }, [adapter]);
  assert.equal((await observer.scan()).forest.length, 1);
  for (step = 1; step <= 2; step++) { const model = await observer.scan(); assert.equal(model.forest.length, 1); assert.equal(model.forest[0].observationStale, true); }
  step = 3; assert.equal((await observer.scan()).forest.length, 0);
});

test('a hung provider cannot stop healthy scans or start overlapping abandoned scans', async t => {
  const root = await temporary(t); let hungCalls = 0, healthyCalls = 0, release;
  const hung = { async scan() { hungCalls++; return new Promise(resolve => { release = resolve; }); } };
  const healthy = { async scan() { return scan([session('healthy-' + ++healthyCalls, { cwd: root })]); } };
  const observer = new Observer({ ...defaults, rootFolder: root, providerTimeoutMs: 25 }, [hung, healthy]);
  const result = await Promise.race([observer.scan(), new Promise((_, reject) => setTimeout(() => reject(Error('Provider blocked dashboard')), 500))]);
  assert.equal(result.forest.length, 1); assert.ok(result.health.diagnostics.includes('HARNESS_TIMEOUT'));
  assert.equal((await observer.scan()).forest[0].shortId, 'healthy-'); assert.equal(healthyCalls, 2); assert.equal(hungCalls, 1);
  release(scan([session('late', { cwd: root })])); await new Promise(resolve => setImmediate(resolve));
  assert.equal(observer.lastGood.has(hung), false, 'late results cannot replace retained observations');
});

test('parser eviction and scan IO limits do not starve later transcripts or erase known summaries', async t => {
  const root = await temporary(t);
  for (const id of ['z', 'y', 'x']) {
    const contents = JSON.stringify({ type: 'session_meta', payload: { session_id: id, cwd: root, cli_version: '0.164.0' } }) + '\n' + JSON.stringify({ type: 'event_msg', timestamp: at, payload: { type: 'task_started' } }) + '\n';
    await fs.writeFile(path.join(root, 'rollout-' + id + '.jsonl'), contents.padEnd(999, ' ') + '\n');
  }
  const adapter = require('../lib/harnesses/codex').create({ roots: [root], limits: { maxCacheBytes: 1000, maxReadBytesPerScan: 3300 } });
  let result; for (let i = 0; i < 6; i++) result = await adapter.scan();
  assert.deepEqual(result.sessions.map(value => value.id).sort(), ['x', 'y', 'z']);
});

test('startup loading remains active across scans until deferred transcripts are read', async t => {
  const root = await temporary(t);
  for (const id of ['z', 'y', 'x']) {
    const contents = JSON.stringify({ type: 'session_meta', payload: { session_id: id, cwd: root, cli_version: '0.164.0' } }) + '\n' + JSON.stringify({ type: 'event_msg', timestamp: at, payload: { type: 'task_started' } }) + '\n';
    await fs.writeFile(path.join(root, 'rollout-' + id + '.jsonl'), contents.padEnd(999, ' ') + '\n');
  }
  const config = { ...defaults, rootFolder: root, sessionRoots: [root], copilotRoots: [], resourceLimits: { maxReadBytesPerScan: 3300 } };
  const observer = new Observer(config);
  const first = await observer.scan();
  assert.equal(first.startupLoading, true);
  assert.ok(first.forest.length < 3);
  let last = first;
  for (let i = 0; i < 5 && last.startupLoading; i++) last = await observer.scan();
  assert.equal(last.startupLoading, false);
  assert.equal(last.forest.length, 3);
});

test('a transcript that cannot fit the scan budget reports a limit instead of loading forever', async t => {
  const root = await temporary(t);
  await fs.writeFile(path.join(root, 'rollout-large.jsonl'), ' '.repeat(2000));
  const observer = new Observer({ ...defaults, rootFolder: root, sessionRoots: [root], copilotRoots: [], resourceLimits: { maxReadBytesPerScan: 1000 } });
  const result = await observer.scan();
  assert.equal(result.startupLoading, false);
  assert.ok(result.health.diagnostics.includes('READ_BUDGET_LIMIT'));
  assert.equal(result.health.fileIssues[0].code, 'READ_BUDGET_LIMIT');
});

test('snapshot transport gate rejects older and duplicate frames, but accepts a restarted observer', () => {
  const gate = require('../public/snapshot').createSnapshotGate();
  const frame = (instanceId, sequence) => ({ health: { instanceId, sequence } });
  const pendingRefresh = gate.capture();
  assert.equal(gate.accept(frame('one', 20)), true);
  assert.equal(gate.accept(frame('one', 19), pendingRefresh), false);
  assert.equal(gate.accept(frame('one', 20)), false);
  assert.equal(gate.accept(frame('unknown-old', 99), pendingRefresh), false);
  assert.equal(gate.accept(frame('two', 1)), true);
  assert.equal(gate.accept(frame('one', 21)), false);
  assert.equal(gate.accept(frame('two', 2)), true);
});

test('workspace projections distinguish selected members from ancestor context', () => {
  const child = { id: 'child', cwd: '/b', tokenUsage: { input: 10 }, children: [] };
  const parent = { id: 'parent', cwd: '/a', tokenUsage: { input: 100 }, children: [child] };
  const result = require('../public/selectors').projectWorkspace([parent], '/b');
  assert.deepEqual([...result.memberIds], ['child']); assert.deepEqual([...result.contextIds], ['parent']);
  assert.equal(result.forest[0].workspaceContext, true);
  assert.equal([...result.memberIds].reduce((sum, id) => sum + (id === child.id ? child : parent).tokenUsage.input, 0), 10);
});

test('provider-qualified node ids migrate existing Modern preferences', () => {
  const old = JSON.stringify(['run', '']), updated = JSON.stringify(['run', '', 'codex']);
  const preferences = require('../public/preferences').normalizePreferences({ collapsed: [old], runKey: old, modernWorkspaceSizes: { [old]: { span: 6 } } });
  assert.deepEqual(preferences.collapsed, [updated]); assert.equal(preferences.runKey, updated);
  assert.deepEqual(preferences.modernWorkspaceSizes[updated], { span: 6 });
});

test('Codex follow-up assignments replace older local tasks while preserving the original assignment', () => {
  const { summarizeTranscript } = require('../lib/harnesses/codex');
  const record = (payload, timestamp) => ({ type: 'response_item', payload, timestamp });
  const parent = summarizeTranscript([
    { type: 'session_meta', payload: { session_id: 'parent', cwd: '/workspace', cli_version: '0.164.0' } },
    record({ type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn', arguments: JSON.stringify({ task_name: 'child', message: 'First assignment' }) }, '2026-10-27T10:00:00Z'),
    record({ type: 'function_call_output', call_id: 'spawn', output: JSON.stringify({ task_name: '/root/child' }) }, '2026-10-27T10:00:01Z'),
    record({ type: 'function_call', namespace: 'collaboration', name: 'followup_task', call_id: 'follow', arguments: JSON.stringify({ target: 'child', message: 'New assignment' }) }, at),
    record({ type: 'function_call_output', call_id: 'follow', output: JSON.stringify({ status: 'running' }) }, at)
  ], '/store/parent.jsonl');
  const child = session('child', { parentId: 'parent', agentPath: '/root/child', currentTask: 'Earlier child work', currentTaskAt: '2026-10-27T11:00:00Z' });
  const result = buildSessionForest([{ ...parent, provider: 'test' }, child])[0].children[0].session;
  assert.equal(result.currentTask, 'New assignment'); assert.equal(result.originalAssignment, 'First assignment'); assert.equal(result.taskSource, 'parent_followup');
});

test('malformed nested sessions cannot defeat observation of a healthy provider', async t => {
  const root = await temporary(t);
  const observer = new Observer({ ...defaults, rootFolder: root }, [
    { async scan() { return scan([session('bad', { cwd: root, spawnedAgents: [null] })]); } },
    { async scan() { return scan([session('good', { cwd: root })]); } }
  ]);
  const result = await observer.scan();
  assert.equal(result.forest.length, 1); assert.equal(result.forest[0].shortId, 'good');
  assert.ok(result.health.diagnostics.includes('SESSION_INVALID'));
});

test('coverage retention is source-specific and does not retain confirmed deletions in healthy stores', async t => {
  const root = await temporary(t); let unavailable = false;
  const adapter = { async scan() { return { unreadable: 0, sources: [{ directory: '/a', status: unavailable ? 'missing' : 'ready' }, { directory: '/b', status: 'ready' }], sessions: unavailable ? [] : [session('a', { cwd: root, sourceDirectory: '/a' }), session('b', { cwd: root, sourceDirectory: '/b' })] }; } };
  const observer = new Observer({ ...defaults, rootFolder: root }, [adapter]);
  await observer.scan(); unavailable = true;
  const result = await observer.scan();
  assert.equal(result.forest.length, 1); assert.equal(result.forest[0].shortId, 'a'); assert.equal(result.forest[0].observationStale, true);
  assert.equal(result.health.status, 'degraded');
});
