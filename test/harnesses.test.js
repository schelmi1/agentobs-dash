'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { harnesses, createHarnesses } = require('../lib/harnesses');
const { Observer } = require('../lib/observer');
const { defaults } = require('../lib/config');

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-harness-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('registered harnesses declare unique identities, config keys and CLI flags', () => {
  for (const field of ['id', 'configKey', 'cliFlag']) assert.equal(new Set(harnesses.map(harness => harness[field])).size, harnesses.length);
  for (const harness of harnesses) {
    assert.equal(typeof harness.label, 'string');
    assert.equal(typeof harness.cliDescription, 'string');
    assert.ok(harness.cliFlag.startsWith('--'));
    assert.ok(harness.defaultRoots(os.tmpdir()).every(root => path.isAbsolute(root)));
  }
});

for (const harness of harnesses) {
  test(harness.label + ' adapter returns an empty scan for disabled stores and reports missing sources', async t => {
    const root = await temporary(t);
    assert.deepEqual(await harness.create({ roots: [] }).scan(), { sessions: [], sources: [], unreadable: 0 });
    const missing = path.join(root, 'missing');
    assert.deepEqual(await harness.create({ roots: [missing] }).scan(), {
      sessions: [], sources: [{ directory: missing, provider: harness.id, status: 'missing' }], unreadable: 0
    });
  });

  test(harness.label + ' adapter shares normalized lifecycle, identity and scan ownership semantics', async t => {
    const root = await temporary(t), store = path.join(root, 'store');
    await fs.mkdir(store);
    const at = new Date().toISOString();
    let file, complete;
    if (harness.id === 'codex') {
      file = path.join(store, 'rollout-contract.jsonl');
      const record = (type, payload) => JSON.stringify({ type, payload, timestamp: at }) + '\n';
      await fs.writeFile(file, record('session_meta', { session_id: 'contract', cwd: root, cli_version: '0.164.0' })
        + record('event_msg', { type: 'task_started', turn_id: 'contract' })
        + record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check harness contract' }] }));
      complete = () => fs.appendFile(file, record('event_msg', { type: 'task_complete', turn_id: 'contract' }));
    } else if (harness.id === 'copilot-vscode') {
      const workspace = path.join(store, 'workspace');
      await fs.mkdir(path.join(workspace, 'chatSessions'), { recursive: true });
      await fs.writeFile(path.join(workspace, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(root).href }));
      file = path.join(workspace, 'chatSessions', 'contract.jsonl');
      await fs.writeFile(file, JSON.stringify({ kind: 0, v: { sessionId: 'contract', version: 3, responderUsername: 'GitHub Copilot', creationDate: at, requests: [{ requestId: 'contract', timestamp: at, message: { text: 'Check harness contract' }, modelState: { value: 0 } }] } }) + '\n');
      complete = () => fs.appendFile(file, JSON.stringify({ kind: 1, k: ['requests', 0, 'modelState'], v: { value: 1 } }) + '\n');
    } else if (harness.id === 'claude-code') {
      await fs.mkdir(path.join(store, 'project'));
      file = path.join(store, 'project', 'contract.jsonl');
      await fs.writeFile(file, JSON.stringify({ type: 'user', sessionId: 'contract', cwd: root, timestamp: at, message: { role: 'user', content: 'Check harness contract' } }) + '\n');
      complete = () => fs.appendFile(file, JSON.stringify({ type: 'assistant', timestamp: at, message: { id: 'answer', content: [], stop_reason: 'end_turn' } }) + '\n');
    } else if (harness.id === 'opencode') {
      const Database = require('better-sqlite3');
      file = path.join(store, 'opencode.db');
      const db = new Database(file);
      db.exec('CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, time_updated INTEGER); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)');
      db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?)').run('contract', root, 'Check harness contract', Date.parse(at));
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run('msg', 'contract', 'user', 1, Date.parse(at), Date.parse(at), JSON.stringify({ text: 'Check harness contract' })); db.close();
      complete = async () => { const next = new Database(file); next.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run('idle', 'contract', 'idle', 2, Date.parse(at), Date.parse(at), JSON.stringify({ outcome: 'succeeded' })); next.close(); };
    } else assert.fail('Add a lifecycle contract fixture for ' + harness.id);
    const adapter = harness.create({ roots: [store] });
    let scan = await adapter.scan();
    assert.equal(scan.unreadable, 0); assert.equal(scan.sources[0].status, 'ready');
    assert.equal(scan.sessions.length, 1);
    const first = scan.sessions[0];
    assert.equal(first.provider, harness.id); assert.equal(first.providerLabel, harness.label);
    assert.equal(first.cwd, root); assert.equal(first.status, 'active');
    assert.equal(first.currentTask, 'Check harness contract');
    assert.ok(Number.isFinite(Date.parse(first.lastActivity))); assert.equal(typeof first.id, 'string');
    first.status = 'stale'; first.cwd = '/mutated-by-caller';
    scan = await adapter.scan();
    assert.equal(scan.sessions[0].status, 'active'); assert.equal(scan.sessions[0].cwd, root);
    await complete(); scan = await adapter.scan();
    assert.equal(scan.sessions[0].status, 'completed');
    await fs.unlink(file); assert.deepEqual((await adapter.scan()).sessions, []);
    assert.deepEqual((await harness.create({ roots: [] }).scan()).sessions, [], 'adapter instances do not share sessions');
  });
}

test('registry creates disabled adapters without falling back to user transcript stores', async () => {
  for (const adapter of createHarnesses({})) assert.deepEqual(await adapter.scan(), { sessions: [], sources: [], unreadable: 0 });
});

test('observer accepts another harness without provider branches and shares concurrent scans', async t => {
  const root = await temporary(t), at = new Date(Date.now() - 20000).toISOString();
  let release, scans = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const source = { directory: '/test-provider-store', provider: 'example', status: 'ready' };
  const inside = { id: 'example:inside', provider: 'example', providerLabel: 'Example', cwd: root, status: 'active', lastActivity: at, spawnedAgentPaths: ['/root/helper'] };
  const adapter = { async scan() {
    scans++; await gate;
    return { sources: [source], unreadable: 2, sessions: [
      inside,
      { id: 'example:outside', provider: 'example', cwd: root + '-outside', status: 'active', lastActivity: at }
    ] };
  } };
  const observer = new Observer({ ...defaults, rootFolder: root, staleAfterMs: 10000, quietHistoryAfterMs: 15000 }, [adapter]);
  const first = observer.scan(), second = observer.scan();
  assert.equal(first, second); release();
  const model = await first;
  assert.equal(scans, 1); assert.equal(model.forest.length, 1);
  assert.equal(model.forest[0].provider, 'example'); assert.equal(model.forest[0].providerLabel, 'Example');
  assert.equal(model.forest[0].children[0].provider, 'example', 'spawn placeholders inherit their harness identity');
  assert.equal(model.forest[0].children[0].providerLabel, 'Example');
  assert.equal(model.forest[0].displayState, 'quiet'); assert.equal(model.forest[0].historyGroup, 'quiet');
  assert.equal(model.unreadableFiles, 2); assert.deepEqual(model.sources, [source]);
  assert.equal(inside.status, 'active', 'shared aging does not mutate a harness snapshot');
});

test('an unexpected adapter rejection releases a shared scan so observation can recover', async t => {
  const root = await temporary(t); let attempts = 0;
  const observer = new Observer({ ...defaults, rootFolder: root }, [{ async scan() {
    if (++attempts === 1) throw new Error('Synthetic adapter failure');
    return { sessions: [], sources: [], unreadable: 0 };
  } }]);
  assert.equal((await observer.scan()).health.status, 'error');
  assert.equal((await observer.scan()).forest.length, 0); assert.equal(attempts, 2);
});
