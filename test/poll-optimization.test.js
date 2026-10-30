'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createIngestion } = require('../lib/ingestion');
const { watchCache } = require('../lib/harnesses/watch-cache');
const { createDashboard } = require('../lib/server');
const { Observer } = require('../lib/observer');
const { defaults } = require('../lib/config');

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-poll-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('persisted summaries avoid replay on restart and are invalidated by changes or parser version', async t => {
  const root = await temporary(t), file = path.join(root, 'input.jsonl'), indexFile = path.join(root, 'index', 'summaries.json');
  await fs.writeFile(file, '{"n":1}\n');
  const factory = () => { let total = 0; return { push: row => { total += row.n; }, snapshot: () => ({ total }) }; };
  const first = createIngestion({}, { indexFile, indexVersion: 'v1' });
  await first.loadIndex(); await first.read(file, factory); await first.saveIndex();
  assert.equal((await fs.stat(indexFile)).mode & 0o777, 0o600);
  const second = createIngestion({}, { indexFile, indexVersion: 'v1' });
  await second.loadIndex(); assert.equal((await second.read(file, factory)).value.total, 1);
  assert.equal(second.stats.readBytes, 0, 'unchanged file is recovered without reading its content');
  await fs.appendFile(file, '{"n":2}\n');
  assert.equal((await second.read(file, factory)).value.total, 3, 'changed file is revalidated and replayed');
  const different = createIngestion({}, { indexFile, indexVersion: 'v2' });
  await different.loadIndex(); assert.equal((await different.read(file, factory)).value.total, 3);
  assert.ok(different.stats.readBytes > 0, 'parser version invalidates old summaries');
  await fs.writeFile(indexFile, '{broken');
  const corrupt = createIngestion({}, { indexFile, indexVersion: 'v1' });
  await corrupt.loadIndex(); assert.equal((await corrupt.read(file, factory)).value.total, 3, 'corrupt index falls back to a scan');
});

test('a restarted observer restores unchanged Codex summaries without reopening transcripts', async t => {
  const root = await temporary(t), store = path.join(root, 'sessions');
  await fs.mkdir(store);
  const file = path.join(store, 'rollout-test.jsonl');
  const records = [
    { type: 'session_meta', timestamp: new Date().toISOString(), payload: { session_id: 'test', cwd: root, cli_version: '0.166.0' } },
    { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Index test' }] } }
  ];
  await fs.writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
  const config = { ...defaults, rootFolder: root, sessionRoots: [store], copilotRoots: [] };
  const first = new Observer(config); t.after(() => first.close());
  assert.equal((await first.scan()).runs.length, 1); await first.close();
  const second = new Observer(config); t.after(() => second.close());
  const open = t.mock.method(fs, 'open');
  const model = await second.scan();
  assert.equal(model.runs[0].title, 'Index test');
  assert.equal(open.mock.calls.filter(call => call.arguments[0] === file).length, 0, 'restart uses the validated persisted summary');
  const idle = await second.scan();
  assert.equal(idle[Symbol.for('agentobs.unchanged')], true, 'unchanged watcher result reuses the model');
  await fs.appendFile(file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', turn_id: 'turn' } }) + '\n');
  const updated = await second.scan();
  assert.equal(Object.values(updated.agents)[0].displayState, 'completed', 'a changed indexed file is read again');
});

test('watch hints skip idle scans, observe writes and periodically reconcile', async t => {
  const root = await temporary(t), file = path.join(root, 'events.jsonl');
  await fs.writeFile(file, 'a');
  let scans = 0;
  const adapter = watchCache({ async scan() { scans++; return { sessions: [], sources: [], unreadable: 0 }; } }, [root], { reconcileMs: 100 });
  t.after(() => adapter.close());
  await adapter.scan(); await adapter.scan(); assert.equal(scans, 1, 'idle scan reuses the last result');
  await fs.appendFile(file, 'b');
  for (let i = 0; i < 20 && scans === 1; i++) { await new Promise(resolve => setTimeout(resolve, 10)); await adapter.scan(); }
  assert.equal(scans, 2, 'a file change triggers discovery');
  await new Promise(resolve => setTimeout(resolve, 120)); await adapter.scan();
  assert.equal(scans, 3, 'full reconciliation eventually runs without a notification');
});

test('an append checks its transcript without restatting unrelated transcripts', async t => {
  const root = await temporary(t), store = path.join(root, 'sessions'); await fs.mkdir(store);
  const at = new Date().toISOString();
  for (let i = 0; i < 30; i++) {
    const records = [
      { type: 'session_meta', timestamp: at, payload: { session_id: String(i), cwd: root, cli_version: '0.166.0' } },
      { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: 'turn' } }
    ];
    await fs.writeFile(path.join(store, 'rollout-' + i + '.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  }
  const observer = new Observer({ ...defaults, rootFolder: root, sessionRoots: [store], copilotRoots: [] });
  t.after(() => observer.close());
  await observer.scan();
  const lstat = t.mock.method(fs, 'lstat');
  const changed = path.join(store, 'rollout-0.jsonl');
  await fs.appendFile(changed, JSON.stringify({ type: 'event_msg', timestamp: at, payload: { type: 'task_complete', turn_id: 'turn' } }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 30));
  const model = await observer.scan();
  assert.equal(Object.values(model.agents).find(agent => agent.shortId === '0').displayState, 'completed');
  const checked = lstat.mock.calls.filter(call => String(call.arguments[0]).startsWith(store + path.sep));
  assert.ok(checked.length <= 2, 'one append should not stat the other 29 files: ' + checked.length);
});

test('changes during a scan and roots created later are not lost', async t => {
  const root = await temporary(t), store = path.join(root, 'later');
  let scans = 0, release, entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  const adapter = watchCache({ async scan() {
    scans++;
    if (scans === 2) { entered(); await new Promise(resolve => { release = resolve; }); }
    return { sessions: [], sources: [], unreadable: 0 };
  } }, [store], { reconcileMs: 10000 });
  t.after(() => adapter.close());
  await adapter.scan(); assert.equal(scans, 1);
  await fs.mkdir(store);
  const running = adapter.scan(); await blocked;
  await fs.writeFile(path.join(store, 'new.jsonl'), 'x');
  await new Promise(resolve => setTimeout(resolve, 20));
  release(); await running; await adapter.scan();
  assert.equal(scans, 3, 'a notification received during the scan triggers another scan');
});

test('unchanged observations send lightweight poll events and changed data sends a snapshot', async t => {
  const root = await temporary(t); let title = 'Initial';
  const adapter = { id: 'fixture', async scan() { return { sessions: [{ id: 'a', cwd: root, provider: 'fixture', providerLabel: 'Fixture', status: 'active', currentTask: title, lastActivity: '2026-01-01T00:00:00Z' }], sources: [], unreadable: 0 }; } };
  const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 50 };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) });
  const url = await dashboard.start(), abort = new AbortController();
  t.after(async () => { abort.abort(); await dashboard.close(); });
  const response = await fetch(url + '/api/events', { signal: abort.signal });
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  const event = async () => {
    while (!buffer.includes('\n\n')) { const chunk = await reader.read(); if (chunk.done) throw Error('stream ended'); buffer += decoder.decode(chunk.value, { stream: true }); }
    const split = buffer.indexOf('\n\n'), frame = buffer.slice(0, split); buffer = buffer.slice(split + 2); return frame;
  };
  let frame;
  do { frame = await event(); } while (!frame.startsWith('data: '));
  assert.match(frame, /Initial/);
  do { frame = await event(); } while (!frame.startsWith('event: observer-poll'));
  assert.doesNotMatch(frame, /Initial/, 'idle event omits the full snapshot');
  title = 'Changed';
  do { frame = await event(); } while (!frame.startsWith('data: '));
  assert.match(frame, /Changed/);
});
