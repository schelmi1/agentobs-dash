'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Observer } = require('../lib/observer');
const { defaults } = require('../lib/config');
const { liveMapModel } = require('../lib/live-map-model');
const { createIngestion } = require('../lib/ingestion');
const { encodeSnapshot } = require('../lib/wire-model');
const { decodeSnapshot } = require('../public/snapshot');
const { normalizePreferences, createPreferenceStore } = require('../public/preferences');
const { filterTree, subagentGroups } = require('../public/selectors');
const { validateScan } = require('../lib/harnesses/contract');

test('file diagnostics are bounded, deduplicated and project only paths and fixed codes', () => {
  const result = validateScan({ sessions: [], sources: [], unreadable: 103, fileIssues: [
    { file: '/store/rollout-0.jsonl', code: 'FILE_LIMIT', message: 'PRIVATE_ERROR' },
    ...Array.from({ length: 103 }, (_, i) => ({ file: '/store/rollout-' + i + '.jsonl', code: 'FILE_LIMIT', output: 'PRIVATE_CONTENT' })),
    { file: 'relative.jsonl', code: 'FILE_LIMIT' }, { file: '/store/raw.jsonl', code: 'PRIVATE_ERROR' }
  ] });
  assert.equal(result.fileIssues.length, 100); assert.equal(result.omittedFileIssues, 3);
  assert.deepEqual(result.fileIssues[0], { file: '/store/rollout-0.jsonl', code: 'FILE_LIMIT' });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('Codex identifies malformed and oversized files through cached scans and snapshot encoding', async t => {
  const root = await fixture(t);
  const expected = [ ['bad', 'PRIVATE invalid JSON\n', 'MALFORMED_RECORD'], ['large', 'x'.repeat(300), 'FILE_LIMIT'], ['record', JSON.stringify({ text: 'x'.repeat(90) }) + '\n', 'RECORD_LIMIT'] ];
  for (const [name, contents] of expected) await fs.writeFile(path.join(root, 'rollout-' + name + '.jsonl'), contents);
  const observer = new Observer({ ...defaults, rootFolder: root, sessionRoots: [root], copilotRoots: [], resourceLimits: { maxFileBytes: 256, maxRecordBytes: 64 } });
  for (let scan = 0; scan < 2; scan++) {
    const model = decodeSnapshot(JSON.parse(encodeSnapshot(await observer.scan())));
    assert.equal(model.unreadableFiles, 3);
    for (const [name, , code] of expected) assert.ok(model.health.fileIssues.some(issue => issue.file === path.join(root, 'rollout-' + name + '.jsonl') && issue.code === code && issue.provider === 'codex'));
    assert.equal(JSON.stringify(model).includes('PRIVATE'), false);
  }
  for (const [name] of expected) await fs.writeFile(path.join(root, 'rollout-' + name + '.jsonl'), '{}\n');
  const recovered = await observer.scan(); assert.equal(recovered.unreadableFiles, 0); assert.equal(recovered.health.fileIssues, undefined);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-production-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
const node = (id, children = []) => ({ session: { id, cwd: '/workspace', provider: 'example', providerLabel: 'Example', status: 'active', currentTask: 'Task', lastActivity: '2026-10-27T00:00:00Z' }, children });
const chain = count => { let result = node('node-' + count); for (let i = count - 1; i > 0; i--) result = node('node-' + i, [result]); return liveMapModel([result]); };

test('wire payload grows linearly and reconstructs shared nodes without serialized trees', () => {
  const start = performance.now(), small = encodeSnapshot(chain(100)), large = encodeSnapshot(chain(200));
  assert.ok(Buffer.byteLength(large) < 500000);
  assert.ok(large.length / small.length < 2.1);
  assert.ok(performance.now() - start < 3000, 'representative 200-agent encoding stays within a three-second load budget');
  const wire = JSON.parse(large); assert.equal(wire.protocolVersion, 2); assert.equal(wire.forest, undefined);
  assert.equal(Object.keys(wire.agents).length, 200);
  const restored = decodeSnapshot(wire);
  assert.equal(restored.forest[0].children[0], restored.agents[restored.forest[0].children[0].id]);
  const limited = decodeSnapshot(JSON.parse(encodeSnapshot(chain(20), { maxAgents: 5 })));
  assert.equal(Object.keys(limited.agents).length, 5); assert.ok(limited.health.diagnostics.includes('SNAPSHOT_LIMIT'));
  assert.throws(() => encodeSnapshot(chain(20), { maxSnapshotBytes: 100 }), { code: 'SNAPSHOT_LIMIT' });
});

test('wire decoder rejects cycles, broken references and unknown protocols', () => {
  const wire = JSON.parse(encodeSnapshot(chain(2)));
  wire.agents[wire.roots[0]].childIds.push('missing'); assert.throws(() => decodeSnapshot(wire));
  assert.throws(() => decodeSnapshot({ protocolVersion: 9000 }));
  const cyclic = JSON.parse(encodeSnapshot(chain(2))); const [a, b] = Object.keys(cyclic.agents);
  cyclic.agents[b].childIds = [a]; assert.throws(() => decodeSnapshot(cyclic));
});

test('provider failure retains stale data, preserves healthy providers and recovers safely', async t => {
  const root = await fixture(t); let broken = false, progress = 'first';
  const provider = id => ({ id, roots: ['/store/' + id], async scan() {
    if (broken && id === 'one') throw new Error('PRIVATE_FAILURE_CONTENT');
    return { sessions: [{ id: id + ':1', provider: id, providerLabel: id, cwd: root, status: 'active', currentTask: progress, lastActivity: new Date().toISOString() }], sources: [{ directory: '/store/' + id, provider: id, status: 'ready' }], unreadable: 0 };
  } });
  const observer = new Observer({ ...defaults, rootFolder: root }, [provider('one'), provider('two')]);
  assert.equal((await observer.scan()).health.status, 'ok');
  broken = true; progress = 'healthy update';
  let model = await observer.scan();
  assert.equal(model.health.status, 'degraded');
  assert.equal(model.forest.find(node => node.provider === 'one').observationStale, true);
  assert.equal(model.forest.find(node => node.provider === 'two').task, 'healthy update');
  assert.equal(model.sources.find(source => source.provider === 'one').code, 'HARNESS_SCAN_FAILED');
  assert.equal(JSON.stringify(model).includes('PRIVATE_FAILURE_CONTENT'), false);
  broken = false; model = await observer.scan();
  assert.equal(model.health.status, 'ok'); assert.ok(model.forest.every(node => !node.observationStale));
});

test('disabled harnesses do not mask failed enabled harnesses as healthy observations', async t => {
  const root = await fixture(t);
  const observer = new Observer({ ...defaults, rootFolder: root }, [{ id: 'disabled', roots: [], scan() { throw new Error('Must not run'); } }, { id: 'broken', roots: ['/store'], async scan() { throw new Error('Failure'); } }]);
  const model = await observer.scan(); assert.equal(model.health.status, 'error'); assert.equal(model.health.providers[0].status, 'disabled');
});

test('malformed contracts and tool payload fields cannot leak through the shared seam', () => {
  assert.throws(() => validateScan({ sessions: [], sources: [] }));
  const scan = validateScan({ sessions: [{ id: 'safe', provider: 'example', providerLabel: 'Example', cwd: '/workspace', status: 'active', toolHistory: [{ name: 'exec', arguments: 'PRIVATE', output: 'PRIVATE', details: { command: 'arbitrary PRIVATE', outputBytes: 8, private: 'PRIVATE' } }] }], sources: [], unreadable: 0 });
  assert.equal(JSON.stringify(scan).includes('PRIVATE'), false); assert.equal(scan.sessions[0].toolHistory[0].details.outputBytes, 8);
  assert.equal(validateScan({ sessions: [{ id: 'bad', cwd: '/workspace', provider: 'bad', providerLabel: 'Bad', status: 'future' }], sources: [], unreadable: 0 }).diagnostics[0], 'SESSION_INVALID');
});

test('root filtering precedes agent budgets and unreadable stores degrade health', async t => {
  const root = await fixture(t);
  const adapter = { id: 'example', async scan() { return { sources: [{ directory: '/store', provider: 'example', status: 'unreadable' }], unreadable: 0, sessions: [
    { id: 'example:outside', provider: 'example', providerLabel: 'Example', cwd: root + '-outside', status: 'active' },
    { id: 'example:inside', provider: 'example', providerLabel: 'Example', cwd: root, status: 'active' }
  ] }; } };
  const result = await new Observer({ ...defaults, rootFolder: root, resourceLimits: { maxAgents: 1 } }, [adapter]).scan();
  assert.equal(result.forest[0].provider, 'example'); assert.equal(result.forest.length, 1);
  assert.equal(result.health.status, 'degraded'); assert.equal(result.health.providers[0].status, 'degraded');
  assert.ok(result.health.diagnostics.includes('SOURCE_UNAVAILABLE'));
});

test('Codex discovery prioritizes recent date directories when file budgets apply', async t => {
  const root = await fixture(t);
  for (const year of ['2024', '2026']) {
    await fs.mkdir(path.join(root, year));
    await fs.writeFile(path.join(root, year, 'rollout-' + year + '.jsonl'), JSON.stringify({ type: 'session_meta', payload: { session_id: year, cwd: root, cli_version: '0.164.0' } }) + '\n');
  }
  const result = await require('../lib/harnesses/codex').create({ roots: [root], limits: { maxFiles: 1 } }).scan();
  assert.equal(result.sessions[0].id, '2026'); assert.ok(result.diagnostics.includes('INGESTION_LIMIT'));
});

test('file budgets reserve capacity for later configured Codex stores', async t => {
  const root = await fixture(t), global = path.join(root, 'global'), local = path.join(root, 'local');
  await fs.mkdir(global); await fs.mkdir(local);
  for (const [store, ids] of [[global, ['2026-a', '2026-b']], [local, ['2026-c']]]) for (const id of ids) await fs.writeFile(path.join(store, 'rollout-' + id + '.jsonl'), JSON.stringify({ type: 'session_meta', payload: { session_id: id, cwd: root, cli_version: '0.164.0' } }) + '\n');
  const result = await require('../lib/harnesses/codex').create({ roots: [global, local], limits: { maxFiles: 2 } }).scan();
  assert.deepEqual(result.sessions.map(session => session.id).sort(), ['2026-b', '2026-c']);
  assert.equal(result.sources.find(source => source.directory === global).status, 'limited');
});

test('invalid preferences recover independently, preserve choices, and tolerate unavailable storage', () => {
  const saved = normalizePreferences({ collapsed: {}, expandedCompleted: 12, search: [], inspectorWidth: Infinity, design: 'orbit', theme: 'blueprint', colors: 'light' });
  assert.deepEqual(saved.collapsed, []); assert.deepEqual(saved.expandedCompleted, []); assert.equal(saved.search, ''); assert.equal(saved.inspectorWidth, undefined);
  assert.equal(saved.design, 'modern'); assert.equal(saved.theme, 'rounded');
  const store = createPreferenceStore({ getItem() { throw new Error('Unavailable'); }, setItem() { throw new Error('Quota'); } });
  assert.deepEqual(store.set({ collapsed: ['one', 'one', 9] }).collapsed, ['one']);
  assert.equal(store.get().theme, 'rounded');
});

test('filters preserve parent context', () => {
  const root = chain(3).forest[0];
  assert.equal(filterTree(root, { search: 'node-3', attentionOnly: false }).children[0].children[0].shortId, 'node-3');
});

test('completed groups retain failed, quiet and active descendants, even through search projections', () => {
  const agent = (id, displayState, children = []) => ({ id, displayState, children });
  const completed = agent('done', 'completed', [agent('done-child', 'completed')]);
  const liveParent = agent('parent', 'completed', [agent('active-child', 'working')]);
  const failed = agent('failed', 'failed'), quiet = agent('quiet', 'quiet');
  const groups = subagentGroups(agent('root', 'working', [completed, liveParent, failed, quiet]));
  assert.equal(groups.completedCount, 2); assert.deepEqual(groups.completed, [completed]); assert.deepEqual(groups.active, [liveParent, failed, quiet]);
  const projection = { ...liveParent, children: [] };
  assert.deepEqual(subagentGroups(agent('root', 'working', [projection]), { parent: liveParent }).active, [projection]);
});

test('append reader avoids whole-file rereads, handles partial UTF-8, truncation and replacement', async t => {
  const root = await fixture(t), file = path.join(root, 'events.jsonl'), reader = createIngestion();
  const factory = () => { let total = 0; return { push(record) { total += record.n || 0; }, snapshot: () => ({ total }) }; };
  await fs.writeFile(file, Array.from({ length: 20000 }, () => '{"n":1}\n').join(''));
  let entry = await reader.read(file, factory); assert.equal(entry.value.total, 20000);
  const baseline = reader.stats.readBytes;
  assert.equal((await reader.read(file, factory)).revision, entry.revision); assert.equal(reader.stats.readBytes, baseline);
  await fs.appendFile(file, '{"n":2}\n{"n":');
  entry = await reader.read(file, factory); assert.equal(entry.value.total, 20002); assert.ok(reader.stats.readBytes - baseline < 2048);
  await fs.appendFile(file, '3,"text":"'); await reader.read(file, factory);
  const utf8 = Buffer.from('é'); await fs.appendFile(file, utf8.subarray(0, 1)); await reader.read(file, factory);
  await fs.appendFile(file, Buffer.concat([utf8.subarray(1), Buffer.from('"}\n')])); assert.equal((await reader.read(file, factory)).value.total, 20005);
  await fs.writeFile(file, '{"n":7}\n'); assert.equal((await reader.read(file, factory)).value.total, 7);
  await fs.rename(file, file + '.old'); await fs.writeFile(file, '{"n":4}'); assert.equal((await reader.read(file, factory)).value.total, 4);
  await fs.appendFile(file, '\n{"n":5}\n'); assert.equal((await reader.read(file, factory)).value.total, 9);
  reader.prune(new Set()); assert.equal(reader.stats.bytes, 0);
});

test('append reader detects same-inode compaction and enforces file, record and cache budgets', async t => {
  const root = await fixture(t), file = path.join(root, 'records');
  const factory = () => { const items = []; return { push(record) { items.push(record); }, snapshot: () => items }; };
  const reader = createIngestion({ maxRecordBytes: 32, maxCacheBytes: 100, maxFileBytes: 256 });
  await fs.writeFile(file, '{"n":1}\n'); await reader.read(file, factory);
  await fs.writeFile(file, '{"n":8}\n{"n":9}\n'); assert.deepEqual((await reader.read(file, factory)).value, [{ n: 8 }, { n: 9 }]);
  await fs.writeFile(file, JSON.stringify({ text: 'x'.repeat(50) }) + '\n'); await assert.rejects(reader.read(file, factory), { code: 'RECORD_LIMIT' });
  await fs.writeFile(file, 'x'.repeat(300)); await assert.rejects(reader.read(file, factory), { code: 'FILE_LIMIT' });
  assert.ok(reader.stats.bytes <= 100);
});

test('scan IO budgets are transient and recover on the next poll', async t => {
  const root = await fixture(t), reader = createIngestion({ maxReadBytesPerScan: 1100 });
  const files = [path.join(root, 'one'), path.join(root, 'two')];
  for (const file of files) await fs.writeFile(file, '{"n":1}\n');
  const factory = () => ({ push() {}, snapshot: () => ({ count: 1 }) });
  await reader.read(files[0], factory);
  // Reserve most of a tiny budget with a longer file.
  await fs.writeFile(files[1], Array.from({ length: 7 }, () => '{"n":1}\n').join(''));
  await assert.rejects(reader.read(files[1], factory), { code: 'INGESTION_LIMIT' });
  reader.beginScan();
  await fs.writeFile(files[1], '{"n":2}\n'); assert.equal((await reader.read(files[1], factory)).value.count, 1);
});

test('completed concurrent Codex calls release correlation state across long runs', async t => {
  const root = await fixture(t), file = path.join(root, 'rollout-long.jsonl');
  const at = new Date().toISOString(), row = (type, payload) => JSON.stringify({ type, payload, timestamp: at }) + '\n';
  await fs.writeFile(file, row('session_meta', { session_id: 'long', cwd: root, cli_version: '0.164.0' }) + row('event_msg', { type: 'task_started' }));
  const adapter = require('../lib/harnesses/codex').create({ roots: [root], limits: { maxStateEntries: 300 } });
  for (let batch = 0; batch < 5; batch++) {
    let records = '';
    for (let index = 0; index < 200; index++) records += row('response_item', { type: 'function_call', name: 'read', call_id: batch + ':' + index, arguments: '{}' });
    for (let index = 0; index < 200; index++) records += row('response_item', { type: 'function_call_output', call_id: batch + ':' + index, output: 'redacted' });
    await fs.appendFile(file, records);
    const scan = await adapter.scan(); assert.equal(scan.unreadable, 0); assert.equal(scan.sessions[0].toolHistory.length, 100); assert.equal(scan.sessions[0].currentTool, undefined);
  }
});
